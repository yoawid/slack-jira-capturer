// Entry point: drives the capture with the Claude Agent SDK.
//
// Replaces the Managed Agents path in run.ts. The three custom tools run
// in-process via an SDK MCP server, so Slack and Atlassian credentials stay in
// this process — there is no sandbox container that could see them.
//
// Auth: uses CLAUDE_CODE_OAUTH_TOKEN (Claude subscription). ANTHROPIC_API_KEY
// must NOT be set — in non-interactive mode it overrides the subscription and
// bills API credits instead.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createBugTicket, createPolarisIdea, getReactionCandidates } from "./tools.ts";

const MODEL = process.env.CAPTURE_MODEL ?? "claude-opus-5";
const MAX_TURNS = Number(process.env.CAPTURE_MAX_TURNS ?? 60);
const CHANNEL = process.env.CAPTURE_CHANNEL ?? "product-management";
const SINCE_HOURS = Number(process.env.CAPTURE_SINCE_HOURS ?? 168);

// Dry run proves auth, Slack access and dedup without creating anything. The
// create tools aren't registered at all rather than merely denied, so a
// misbehaving prompt cannot reach them.
const DRY_RUN = process.env.CAPTURE_DRY_RUN === "1";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

// Compose the message Claude reads on failure, rather than letting a raw
// exception through — it needs enough to decide whether to retry or move on.
const fail = (where: string, err: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: `${where} failed: ${err instanceof Error ? err.message : String(err)}`,
    },
  ],
  isError: true,
});

const readCandidates = tool(
  "get_reaction_candidates",
  "Fetch Slack messages from a channel posted within the last N hours that have a 💡 (`bulb`) OR 🐛 (`bug`) emoji reaction. Returns each candidate with its `reaction` type, source (ybug / template / generic), pre-extracted title/product_area when available, text body, author, permalink, and slack_channel_id + slack_ts for posting confirmation replies. Messages already filed in a previous run are removed before returning.",
  {
    channel: z.string().describe("Channel name without the # prefix"),
    since_hours: z
      .number()
      .int()
      .default(SINCE_HOURS)
      .describe("How far back to look in hours"),
  },
  async (args) => {
    try {
      return ok(await getReactionCandidates(args));
    } catch (err) {
      return fail("get_reaction_candidates", err);
    }
  },
  // Read-only: safe to batch, and never creates anything.
  { annotations: { readOnlyHint: true } },
);

const createIdea = tool(
  "create_polaris_idea",
  "Create a Jira Polaris idea in the given project AND post a confirmation reply in the original Slack thread. Returns the new issue key and URL on success. Always pass slack_channel_id and slack_ts from the candidate so the reply is threaded correctly.",
  {
    project_key: z.string(),
    idea_issue_type_id: z.string(),
    title: z.string().describe("Idea summary, ≤ 80 chars"),
    description: z.string(),
    product_area_field_id: z.string(),
    product_area_option_id: z.string(),
    planning_status_option_id: z.string(),
    slack_channel_id: z.string().describe("From candidate.slack_channel_id"),
    slack_ts: z.string().describe("From candidate.slack_ts"),
  },
  async (args) => {
    try {
      return ok(await createPolarisIdea(args));
    } catch (err) {
      return fail("create_polaris_idea", err);
    }
  },
);

const createBug = tool(
  "create_bug_ticket",
  "Create a Jira Bug ticket in project NET AND post a confirmation reply in the original Slack thread. Project (NET) and issue type (Bug) are filled in for you — provide only title and description. Returns the new issue key and URL on success.",
  {
    title: z.string().describe('Bug summary (Jira "summary" field). ≤ 80 chars.'),
    description: z.string().describe("Plain text; include author and Slack permalink."),
    slack_channel_id: z.string().describe("From candidate.slack_channel_id"),
    slack_ts: z.string().describe("From candidate.slack_ts"),
  },
  async (args) => {
    try {
      return ok(await createBugTicket(args));
    } catch (err) {
      return fail("create_bug_ticket", err);
    }
  },
);

const capturer = createSdkMcpServer({
  name: "capturer",
  version: "1.0.0",
  tools: DRY_RUN ? [readCandidates] : [readCandidates, createIdea, createBug],
});

const LIVE_PROMPT = `You triage messages from Slack into Jira based on emoji reactions:
  - 💡 (\`bulb\`) → Polaris Idea in project MPR
  - 🐛 (\`bug\`)  → Bug ticket in project NET

WORKFLOW (every run):
1. Call \`mcp__capturer__get_reaction_candidates\` with channel="${CHANNEL}" and
   since_hours=${SINCE_HOURS}. Already-filed messages are removed for you.
2. For each candidate, dispatch by \`candidate.reaction\`:
     - reaction == "bulb" → call \`mcp__capturer__create_polaris_idea\`
     - reaction == "bug"  → call \`mcp__capturer__create_bug_ticket\`
   Always pass slack_channel_id and slack_ts from the candidate so the Slack
   confirmation reply lands in the right thread.
   File each candidate exactly once. Never call a create tool twice for the
   same slack_ts, even if a previous call returned an error.

============================================================
IDEA (reaction 💡 → MPR / Polaris)
============================================================
Pinned field IDs for project MPR (no discovery needed):
  - project_key:                "MPR"
  - idea_issue_type_id:         "10169"
  - product_area_field_id:      "customfield_11018"
  - planning_status_option_id:  "11275"  (Investigate)

Product area option IDs (pick the closest match — never skip):
  - User interfaces:           "11267"
  - Smart control:             "11268"
  - Integrations:              "11269"
  - Reporting & Insights:      "11270"
  - Zone asset adaptation:     "11273"

Idea content (depends on candidate.source):
  If source == "ybug":
    - title: "Ybug - " + candidate.pre_title (≤ 80 chars total)
    - description: candidate.text + author + permalink
    - product_area: classify from text
  If source == "template":
    - title: candidate.pre_title verbatim (≤ 80 chars — truncate if needed)
    - description: candidate.text + author + permalink
    - product_area: if candidate.product_area is set, map directly to the
      matching option ID (case-insensitive, tolerate "&"/"and"). Do NOT
      re-classify when pre-tagged.
  If source == "generic":
    - title: concise summary of candidate.text (≤ 80 chars)
    - description: candidate.text + author + permalink
    - product_area: classify from text

============================================================
BUG (reaction 🐛 → NET)
============================================================
Pass to \`mcp__capturer__create_bug_ticket\`:
  - title: concise headline (≤ 80 chars)
      - source "ybug":     "Ybug - " + candidate.pre_title
      - source "template": candidate.pre_title verbatim
      - source "generic":  brief summary of candidate.text
  - description: candidate.text + author + permalink

============================================================
FINAL SUMMARY (markdown)
============================================================
List each candidate with the outcome. Include the kind:
  - 💡 <slack-permalink> → MPR-NNN  https://myrspoven.atlassian.net/browse/MPR-NNN
  - 🐛 <slack-permalink> → NET-NNN  https://myrspoven.atlassian.net/browse/NET-NNN
  - <slack-permalink> → FAILED: <reason>  (on failure)
If no candidates, just say so.`;

const DRY_PROMPT = `This is a dry run. You have exactly one tool and it only reads.
Create nothing, and do not describe tickets as though they were created.

1. Call \`mcp__capturer__get_reaction_candidates\` with channel="${CHANNEL}" and
   since_hours=${SINCE_HOURS}.
2. Report, in markdown:
   - Total candidates returned (these are already deduped — anything filed in a
     previous run has been removed).
   - A count by \`reaction\` (bulb vs bug).
   - A count by \`source\` (ybug / template / generic), and generic as a
     percentage of the total. State these numbers plainly; they decide whether
     the classification step can be replaced with deterministic code.
   - For each candidate, one line: reaction, source, author, and the title that
     *would* be used — for ybug/template that is pre_title, for generic your
     one-line summary.
   - Whether \`product_area\` was pre-tagged, per candidate.
If there are no candidates, say so and stop.`;

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    // In non-interactive mode an API key always wins over the subscription, so
    // leaving it set silently bills API credits — the exact failure this port
    // exists to remove. Refuse rather than bill the wrong account.
    throw new Error(
      "ANTHROPIC_API_KEY is set. In headless mode it overrides CLAUDE_CODE_OAUTH_TOKEN " +
        "and bills API credits instead of the Claude subscription. Unset it.",
    );
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is not set. Generate one with `claude setup-token`.",
    );
  }

  console.log(
    `[capture] model=${MODEL} channel=#${CHANNEL} window=${SINCE_HOURS}h` +
      `${DRY_RUN ? " MODE=DRY-RUN (creates nothing)" : " MODE=LIVE"}`,
  );

  let summary = "";

  for await (const message of query({
    prompt: DRY_RUN ? DRY_PROMPT : LIVE_PROMPT,
    options: {
      model: MODEL,
      systemPrompt: DRY_RUN
        ? "You are a read-only reporting assistant. You never invent results."
        : LIVE_PROMPT,
      maxTurns: MAX_TURNS,
      mcpServers: { capturer },
      allowedTools: DRY_RUN
        ? ["mcp__capturer__get_reaction_candidates"]
        : ["mcp__capturer__*"],
      // Strip every built-in: this agent has no business reading files,
      // running bash, or searching the web.
      tools: [],
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      const unavailable = message.mcp_servers.filter(
        (s: { status: string }) => s.status === "failed" || s.status === "needs-auth",
      );
      if (unavailable.length > 0) {
        console.error("[mcp] unavailable:", JSON.stringify(unavailable));
      }
    }

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
        if (block.type === "tool_use") console.log(`\n[tool] ${block.name}`);
      }
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        summary = message.result;
      } else {
        throw new Error(`Agent run ended: ${message.subtype}`);
      }
    }
  }

  console.log(`\n\n=== Summary ===\n${summary}`);
}

main().catch((err) => {
  console.error(`\nCapture aborted: ${err instanceof Error ? err.message : String(err)}`);
  console.error(
    "Re-run once fixed. Reactions stay capturable for 7 days after they are posted — " +
      "a failure lasting longer than that drops them silently.",
  );
  process.exit(1);
});
