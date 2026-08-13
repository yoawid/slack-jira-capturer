import dotenv from "dotenv";
dotenv.config({ override: true });
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const AGENT_ID = process.env.AGENT_ID!;
const ENV_ID = process.env.ENV_ID!;

// Slack
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

// Atlassian (basic auth)
const ATLASSIAN_SITE = process.env.ATLASSIAN_SITE!; // e.g. myrspoven.atlassian.net
const ATLASSIAN_EMAIL = process.env.ATLASSIAN_EMAIL!;
const ATLASSIAN_API_TOKEN = process.env.ATLASSIAN_API_TOKEN!;
const PLANNING_STATUS_FIELD = "customfield_10754";

// =================== Slack ===================

type ReactionCandidate = {
  reaction: "bulb" | "bug"; // 💡 → Polaris Idea (MPR), 🐛 → Bug ticket (NET)
  source: "ybug" | "template" | "generic";
  pre_title?: string;
  product_area?: string;
  text: string;
  author: string;
  permalink: string;
  slack_ts: string;
  slack_channel_id: string;
};

// Parse a Ybug bot_message — title + Summary field from the first attachment.
function parseYbug(msg: SlackMessageRaw): {
  pre_title: string;
  body: string;
} | null {
  const a = msg.attachments?.[0];
  if (!a || a.footer !== "Reported via Ybug") return null;
  // Title example: "[myPortal myrspoven] #199 Eran interna chatbot..."
  const title = (a.title ?? "").replace(/^\[[^\]]+\]\s*/, "").trim();
  const summary = a.fields?.find((f) => f.title === "Summary")?.value ?? "";
  return { pre_title: title || "Ybug report", body: summary || a.title || "" };
}

// Parse a template message ("<@U...> - submitted feedback" with bullet fields).
function parseTemplate(msg: SlackMessageRaw): {
  pre_title: string;
  product_area?: string;
  body: string;
} | null {
  const text = msg.text ?? "";
  if (!/submitted feedback/i.test(text)) return null;
  const get = (label: string) =>
    text.match(new RegExp(`${label}:\\s*(.+)`, "i"))?.[1]?.trim();
  const title = get("Title");
  if (!title) return null;
  const product = get("Product");
  // Slack escapes & as &amp;
  const productClean = product?.replace(/&amp;/g, "&");
  const detailsMatch = text.match(/Details:\s*\n?([\s\S]*)$/i);
  const details = detailsMatch?.[1]?.trim() ?? "";
  return { pre_title: title, product_area: productClean, body: details || title };
}

type SlackMessageRaw = {
  text?: string;
  user?: string;
  username?: string;
  ts: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  reactions?: { name: string; users?: string[] }[];
  attachments?: {
    title?: string;
    text?: string;
    footer?: string;
    fallback?: string;
    fields?: { title: string; value: string }[];
  }[];
};

async function slackApi<T>(method: string, params: Record<string, string>): Promise<T> {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const json = (await resp.json()) as T & { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
  return json;
}

async function getReactionCandidates(input: {
  channel: string;
  since_hours?: number;
}): Promise<{ candidates: ReactionCandidate[] }> {
  const hours = input.since_hours ?? 24;
  const oldest = (Date.now() / 1000 - hours * 3600).toFixed(0);

  const channelsResp = await slackApi<{ channels: { id: string; name: string }[] }>(
    "conversations.list",
    { types: "public_channel,private_channel", limit: "1000" },
  );
  const channel = channelsResp.channels.find((c) => c.name === input.channel);
  if (!channel) throw new Error(`Channel #${input.channel} not found or bot not invited`);

  const historyResp = await slackApi<{ messages: SlackMessageRaw[] }>(
    "conversations.history",
    { channel: channel.id, oldest, limit: "200" },
  );

  const candidates: ReactionCandidate[] = [];
  const userCache = new Map<string, string>();

  async function resolveUserName(userId: string): Promise<string> {
    if (!userCache.has(userId)) {
      const u = await slackApi<{ user: { real_name?: string; name?: string } }>(
        "users.info",
        { user: userId },
      );
      userCache.set(userId, u.user.real_name ?? u.user.name ?? userId);
    }
    return userCache.get(userId)!;
  }

  function extractGenericText(msg: SlackMessageRaw): string {
    if (msg.text && msg.text.trim()) return msg.text.trim();
    const parts: string[] = [];
    for (const a of msg.attachments ?? []) {
      if (a.title) parts.push(a.title);
      if (a.text) parts.push(a.text);
      for (const f of a.fields ?? []) parts.push(`${f.title}: ${f.value}`);
      if (parts.length === 0 && a.fallback) parts.push(a.fallback);
    }
    return parts.join("\n").trim() || "(no text content)";
  }

  function detectReaction(msg: SlackMessageRaw): "bulb" | "bug" | null {
    for (const r of msg.reactions ?? []) {
      if (r.name === "bulb" || r.name === "light_bulb") return "bulb";
      if (r.name === "bug") return "bug";
    }
    return null;
  }

  for (const msg of historyResp.messages ?? []) {
    const reaction = detectReaction(msg);
    if (!reaction) continue;

    // Try structured parsers first, fall back to generic
    const ybug = parseYbug(msg);
    const template = !ybug ? parseTemplate(msg) : null;

    let source: ReactionCandidate["source"];
    let pre_title: string | undefined;
    let product_area: string | undefined;
    let body: string;

    if (ybug) {
      source = "ybug";
      pre_title = ybug.pre_title;
      body = ybug.body;
    } else if (template) {
      source = "template";
      pre_title = template.pre_title;
      product_area = template.product_area;
      body = template.body;
    } else {
      source = "generic";
      body = extractGenericText(msg);
    }

    // Resolve author: prefer the message poster; fall back to bot/username/reactor.
    let author: string;
    if (msg.user) {
      author = await resolveUserName(msg.user);
    } else if (msg.bot_profile?.name) {
      author = `${msg.bot_profile.name} (bot)`;
    } else if (msg.username) {
      author = `${msg.username} (bot)`;
    } else {
      author = "Unknown";
    }

    // If the message has no real author (bot post), credit the reactor too.
    const reactionMatchers =
      reaction === "bulb"
        ? (n: string) => n === "bulb" || n === "light_bulb"
        : (n: string) => n === "bug";
    const reactors =
      msg.reactions?.find((r) => reactionMatchers(r.name))?.users ?? [];
    if (!msg.user && reactors.length > 0) {
      const reactorName = await resolveUserName(reactors[0]);
      author = `${author}, flagged by ${reactorName}`;
    }

    const perma = await slackApi<{ permalink: string }>("chat.getPermalink", {
      channel: channel.id,
      message_ts: msg.ts,
    });

    candidates.push({
      reaction,
      source,
      pre_title,
      product_area,
      text: body,
      author,
      permalink: perma.permalink,
      slack_ts: msg.ts,
      slack_channel_id: channel.id,
    });
  }

  // Dedup: skip candidates where the bot has already posted a confirmation
  // reply in the thread. The bot's reply is authoritative and catches tickets
  // we created in any prior run, regardless of how they ended up in Jira.
  if (candidates.length === 0) return { candidates };
  const fresh: ReactionCandidate[] = [];
  for (const c of candidates) {
    if (await hasBotConfirmation(c.slack_channel_id, c.slack_ts)) continue;
    fresh.push(c);
  }
  console.log(
    `[dedup] ${candidates.length} candidates, ${candidates.length - fresh.length} already filed, ${fresh.length} fresh`,
  );
  return { candidates: fresh };
}

const BOT_CONFIRMATION_RE = /Created a (Bug|Idea) from this message:/;

async function hasBotConfirmation(channel: string, thread_ts: string): Promise<boolean> {
  const resp = await slackApi<{ messages?: SlackMessageRaw[] }>(
    "conversations.replies",
    { channel, ts: thread_ts, limit: "50" },
  );
  for (const m of resp.messages ?? []) {
    if (m.ts === thread_ts) continue;
    if (m.text && BOT_CONFIRMATION_RE.test(m.text)) return true;
  }
  return false;
}

// =================== Atlassian ===================

const atlassianAuth = `Basic ${Buffer.from(
  `${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`,
).toString("base64")}`;

async function atlassianApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const resp = await fetch(`https://${ATLASSIAN_SITE}${path}`, {
    method,
    headers: {
      Authorization: atlassianAuth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Atlassian ${method} ${path} → ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function discoverIdeaFields(input: { project_key: string }) {
  const meta = (await atlassianApi(
    "GET",
    `/rest/api/3/issue/createmeta?projectKeys=${input.project_key}` +
      `&issuetypeNames=Idea&expand=projects.issuetypes.fields`,
  )) as {
    projects: {
      issuetypes: {
        id: string;
        name: string;
        fields: Record<
          string,
          { name: string; allowedValues?: { id: string; value: string }[] }
        >;
      }[];
    }[];
  };

  const project = meta.projects?.[0];
  if (!project) throw new Error(`Project ${input.project_key} not found`);
  const idea = project.issuetypes.find((t) => t.name === "Idea");
  if (!idea) throw new Error(`Idea issue type not found in ${input.project_key}`);

  // Find the Product area field by name (case-insensitive)
  let productAreaFieldId: string | undefined;
  let productAreaOptions: { id: string; value: string }[] = [];
  for (const [fieldId, fieldMeta] of Object.entries(idea.fields)) {
    if (fieldMeta.name?.toLowerCase() === "product area") {
      productAreaFieldId = fieldId;
      productAreaOptions = fieldMeta.allowedValues ?? [];
      break;
    }
  }

  // Planning status options
  const planningStatus = idea.fields[PLANNING_STATUS_FIELD];
  const planningStatusOptions = planningStatus?.allowedValues ?? [];

  return {
    idea_issue_type_id: idea.id,
    product_area_field_id: productAreaFieldId,
    product_area_options: productAreaOptions,
    planning_status_field_id: PLANNING_STATUS_FIELD,
    planning_status_options: planningStatusOptions,
  };
}

async function postSlackConfirmation(args: {
  channel: string;
  thread_ts: string;
  issue_key: string;
  issue_url: string;
  title: string;
  kind: "Idea" | "Bug";
}) {
  const status = args.kind === "Idea" ? "Investigate" : "To Do";
  const text =
    `:robot_face: Created a ${args.kind} from this message: ` +
    `<${args.issue_url}|${args.issue_key}: ${args.title}>  •  Status: *${status}*`;
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channel,
      thread_ts: args.thread_ts,
      text,
      unfurl_links: false,
    }),
  });
  const json = (await resp.json()) as { ok: boolean; error?: string };
  if (!json.ok) {
    // Don't throw — idea was created, posting reply is best-effort.
    console.error(`[slack reply] failed: ${json.error}`);
  }
}

async function createPolarisIdea(input: {
  project_key: string;
  idea_issue_type_id: string;
  title: string;
  description: string;
  product_area_field_id: string;
  product_area_option_id: string;
  planning_status_option_id: string;
  slack_channel_id: string;
  slack_ts: string;
}) {
  const fields: Record<string, unknown> = {
    project: { key: input.project_key },
    issuetype: { id: input.idea_issue_type_id },
    summary: input.title,
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: input.description }],
        },
      ],
    },
    [input.product_area_field_id]: { id: input.product_area_option_id },
    [PLANNING_STATUS_FIELD]: { id: input.planning_status_option_id },
  };

  const resp = (await atlassianApi("POST", "/rest/api/3/issue", { fields })) as {
    key: string;
  };

  const idea_url = `https://${ATLASSIAN_SITE}/browse/${resp.key}`;

  await postSlackConfirmation({
    channel: input.slack_channel_id,
    thread_ts: input.slack_ts,
    issue_key: resp.key,
    issue_url: idea_url,
    title: input.title,
    kind: "Idea",
  });

  return { key: resp.key, url: idea_url };
}

const NET_BUG_ISSUE_TYPE_ID = "10004";

async function createBugTicket(input: {
  title: string;
  description: string;
  slack_channel_id: string;
  slack_ts: string;
}) {
  const fields: Record<string, unknown> = {
    project: { key: "NET" },
    issuetype: { id: NET_BUG_ISSUE_TYPE_ID },
    summary: input.title,
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: input.description }],
        },
      ],
    },
  };

  const resp = (await atlassianApi("POST", "/rest/api/3/issue", { fields })) as {
    key: string;
  };

  const url = `https://${ATLASSIAN_SITE}/browse/${resp.key}`;

  await postSlackConfirmation({
    channel: input.slack_channel_id,
    thread_ts: input.slack_ts,
    issue_key: resp.key,
    issue_url: url,
    title: input.title,
    kind: "Bug",
  });

  return { key: resp.key, url };
}

// =================== Custom tool dispatch ===================

async function runCustomTool(name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case "get_reaction_candidates":
      return getReactionCandidates(input as Parameters<typeof getReactionCandidates>[0]);
    case "discover_idea_fields":
      return discoverIdeaFields(input as Parameters<typeof discoverIdeaFields>[0]);
    case "create_polaris_idea":
      return createPolarisIdea(input as Parameters<typeof createPolarisIdea>[0]);
    case "create_bug_ticket":
      return createBugTicket(input as Parameters<typeof createBugTicket>[0]);
    default:
      throw new Error(`Unknown custom tool: ${name}`);
  }
}

// =================== Session loop ===================

async function main() {
  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: `Capture Slack ideas — ${new Date().toISOString()}`,
  });
  console.log(`Session: ${session.id}\n`);

  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Run the workflow now." }],
      },
    ],
  });

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const block of event.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (event.type === "agent.custom_tool_use") {
      console.log(`\n[custom] ${event.name}`);
      try {
        const result = await runCustomTool(event.name, event.input);
        await client.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: JSON.stringify(result) }],
            },
          ],
        });
      } catch (err) {
        await client.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: String(err) }],
              is_error: true,
            },
          ],
        });
      }
    } else if (event.type === "session.status_terminated") {
      break;
    } else if (event.type === "session.status_idle") {
      if (event.stop_reason.type !== "requires_action") break;
    }
  }

  console.log(`\n\nDone. Session: ${session.id}`);
}

// Known-cause API failures get a one line fix instead of a stack dump. Anything
// unrecognised keeps the full error — losing debuggability is worse than noise.
function explainFatal(err: unknown): string | null {
  const status = (err as { status?: number })?.status;
  const message = String(
    (err as { error?: { error?: { message?: string } } })?.error?.error?.message ?? "",
  );

  if (status === 400 && /credit balance is too low/i.test(message)) {
    return "Anthropic credit balance is empty. Top up at platform.claude.com under Plans & Billing, and enable auto-reload so it cannot hit zero unnoticed. Note credits also expire one year after purchase.";
  }
  if (status === 401 || status === 403) {
    return "ANTHROPIC_API_KEY was rejected. Check the secret is set and has not been revoked.";
  }
  if (status === 429) {
    return "Rate limited by the Anthropic API.";
  }
  return null;
}

main().catch((err) => {
  const cause = explainFatal(err);
  if (!cause) {
    console.error(err);
    process.exit(1);
  }

  console.error(`\nCapture aborted: ${cause}`);
  // Re-running is safe: dedup checks both Jira and the Slack thread before filing.
  console.error(
    "Re-run once fixed. Reactions stay capturable for 7 days after they are posted — a failure lasting longer than that drops them silently.",
  );
  process.exit(1);
});
