// Slack + Atlassian side of the capturer. No Anthropic dependency: these are
// plain async functions, wrapped as agent tools by capture.ts.
//
// Credentials are read here and never leave this process.

const PLANNING_STATUS_FIELD = "customfield_10754";
const NET_BUG_ISSUE_TYPE_ID = "10004";
const BOT_CONFIRMATION_RE = /Created a (Bug|Idea) from this message:/;

// Read lazily rather than at module load: ES imports are evaluated before the
// importing module's body, so a top-level read here would run before the
// caller's dotenv.config(). Also turns a missing var into a clear error
// instead of `Bearer undefined` and a confusing Slack failure.
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type ReactionCandidate = {
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

// =================== Slack ===================

async function slackApi<T>(method: string, params: Record<string, string>): Promise<T> {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${env("SLACK_BOT_TOKEN")}` },
  });
  const json = (await resp.json()) as T & { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
  return json;
}

// Parse a Ybug bot_message — title + Summary field from the first attachment.
function parseYbug(msg: SlackMessageRaw): { pre_title: string; body: string } | null {
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
  submitter_id?: string;
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
  // These are posted by a workflow, so msg.user is empty and the author would
  // otherwise resolve to "Unknown". The real submitter is the mention in the
  // header line — anchored there so a mention inside Details can't win.
  const submitter = text.match(
    /^\s*<@([UW][A-Z0-9]+)>[^\n]*submitted feedback/i,
  )?.[1];
  return {
    pre_title: title,
    product_area: productClean,
    body: details || title,
    submitter_id: submitter,
  };
}

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

export async function getReactionCandidates(input: {
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
    let submitter_id: string | undefined;
    let body: string;

    if (ybug) {
      source = "ybug";
      pre_title = ybug.pre_title;
      body = ybug.body;
    } else if (template) {
      source = "template";
      pre_title = template.pre_title;
      product_area = template.product_area;
      submitter_id = template.submitter_id;
      body = template.body;
    } else {
      source = "generic";
      body = extractGenericText(msg);
    }

    // Resolve author: prefer the message poster, then a submitter named inside
    // the message body, then bot/username/reactor.
    let author: string;
    if (msg.user) {
      author = await resolveUserName(msg.user);
    } else if (submitter_id) {
      author = await resolveUserName(submitter_id);
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
    const reactors = msg.reactions?.find((r) => reactionMatchers(r.name))?.users ?? [];
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
      Authorization: `Bearer ${env("SLACK_BOT_TOKEN")}`,
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
    // Don't throw — issue was created, posting the reply is best-effort.
    // NOTE: dedup keys off this reply, so a silent failure here means the
    // next run re-files the same message. Carried over from run.ts unchanged.
    console.error(`[slack reply] failed: ${json.error}`);
  }
}

// =================== Atlassian ===================

async function atlassianApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const auth = `Basic ${Buffer.from(
    `${env("ATLASSIAN_EMAIL")}:${env("ATLASSIAN_API_TOKEN")}`,
  ).toString("base64")}`;
  const resp = await fetch(`https://${env("ATLASSIAN_SITE")}${path}`, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Atlassian ${method} ${path} → ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function adfParagraph(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export async function createPolarisIdea(input: {
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
    description: adfParagraph(input.description),
    [input.product_area_field_id]: { id: input.product_area_option_id },
    [PLANNING_STATUS_FIELD]: { id: input.planning_status_option_id },
  };

  const resp = (await atlassianApi("POST", "/rest/api/3/issue", { fields })) as {
    key: string;
  };
  const url = `https://${env("ATLASSIAN_SITE")}/browse/${resp.key}`;

  await postSlackConfirmation({
    channel: input.slack_channel_id,
    thread_ts: input.slack_ts,
    issue_key: resp.key,
    issue_url: url,
    title: input.title,
    kind: "Idea",
  });

  return { key: resp.key, url };
}

export async function createBugTicket(input: {
  title: string;
  description: string;
  slack_channel_id: string;
  slack_ts: string;
}) {
  const fields: Record<string, unknown> = {
    project: { key: "NET" },
    issuetype: { id: NET_BUG_ISSUE_TYPE_ID },
    summary: input.title,
    description: adfParagraph(input.description),
  };

  const resp = (await atlassianApi("POST", "/rest/api/3/issue", { fields })) as {
    key: string;
  };
  const url = `https://${env("ATLASSIAN_SITE")}/browse/${resp.key}`;

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
