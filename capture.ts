// Entry point. Slack reactions in, Jira issues out, a threaded reply back.
// Every decision is a rule in parsers.ts; nothing here asks a model anything.
import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { appendFileSync } from "node:fs";
import { loadConfig, loadSecrets, type Config } from "./config.ts";
import { JiraClient, adf, slackTsLabel } from "./jira.ts";
import {
  buildDescription,
  deriveTitle,
  detectReaction,
  mapProductArea,
  mentionedUserIds,
  parseMessage,
  reactorsOf,
  stripSlackMarkup,
  type Parsed,
  type Reaction,
} from "./parsers.ts";
import { withRetry } from "./retry.ts";
import { SlackClient, confirmationText, type SlackMessage } from "./slack.ts";

const DRY_RUN = process.argv.includes("--dry-run") || process.env.CAPTURE_DRY_RUN === "1";
// Titles and permalinks are internal; keep them out of CI logs unless asked.
const VERBOSE = DRY_RUN || process.env.CAPTURE_VERBOSE === "1";

const log = (message: string) => console.log(message);
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const icon = (reaction: Reaction) => (reaction === "bulb" ? "💡" : "🐛");

type Candidate = { msg: SlackMessage; reaction: Reaction; parsed: Parsed; label: string };

type Outcome = {
  reaction: Reaction;
  status: "created" | "created_no_reply" | "failed";
  key?: string;
  error?: string;
};

async function resolveAuthor(c: Candidate, slack: SlackClient): Promise<string> {
  const { msg, parsed, reaction } = c;
  let author: string;
  if (msg.user) author = await slack.userName(msg.user);
  else if (parsed.submitterId) author = await slack.userName(parsed.submitterId);
  else if (msg.bot_profile?.name) author = `${msg.bot_profile.name} (bot)`;
  else if (msg.username) author = `${msg.username} (bot)`;
  else author = "Unknown";
  // A bot post has no human author, so credit whoever flagged it.
  const reactors = reactorsOf(msg, reaction);
  if (!msg.user && reactors.length > 0) author += `, flagged by ${await slack.userName(reactors[0]!)}`;
  return author;
}

async function prepare(c: Candidate, config: Config, slack: SlackClient) {
  const { msg, parsed, reaction } = c;
  const names = new Map<string, string>();
  for (const id of mentionedUserIds(parsed.body)) names.set(id, await slack.userName(id));
  const body = stripSlackMarkup(parsed.body, names);
  const title = deriveTitle(parsed.source, parsed.preTitle, body);
  const author = await resolveAuthor(c, slack);
  const permalink = await slack.permalink(config.slack.channel_id, msg.ts);

  const idea = config.jira.idea;
  const areaConfig = reaction === "bulb" ? idea.product_area : undefined;
  const areaValues =
    parsed.source === "ybug" && areaConfig?.default_for_ybug ? [areaConfig.default_for_ybug] : parsed.productValues;
  const productArea = areaConfig ? mapProductArea(areaValues, areaConfig.options) : null;

  const description = buildDescription({
    body,
    author,
    permalink,
    productValues: parsed.source === "template" ? parsed.productValues : [],
    type: parsed.type,
    impact: parsed.impact,
    productAreaUnmapped: Boolean(areaConfig && areaValues.length > 0 && !productArea),
  });

  const fields: Record<string, unknown> = { summary: title, description: adf(description), labels: [c.label] };
  if (reaction === "bulb") {
    fields.project = { key: idea.project_key };
    fields.issuetype = { id: idea.issue_type_id };
    if (idea.planning_status) fields[idea.planning_status.field_id] = { id: idea.planning_status.option_id };
    if (productArea && areaConfig) fields[areaConfig.field_id] = { id: productArea.option_id };
    if (idea.impact_field_id && parsed.impact !== undefined && parsed.impact >= 1 && parsed.impact <= 5) {
      fields[idea.impact_field_id] = parsed.impact;
    }
  } else {
    fields.project = { key: config.jira.bug.project_key };
    fields.issuetype = { id: config.jira.bug.issue_type_id };
  }
  const optionalFieldIds = [idea.planning_status?.field_id, areaConfig?.field_id, idea.impact_field_id].filter(
    (id): id is string => Boolean(id),
  );
  return { title, author, permalink, productArea, fields, optionalFieldIds };
}

function writeStepSummary(outcomes: Outcome[]) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const rows = outcomes.map(
    (o) => `| ${icon(o.reaction)} | ${o.status.replace(/_/g, " ")} | ${o.key ?? "—"} | ${o.error ?? ""} |`,
  );
  appendFileSync(path, ["| Reaction | Outcome | Issue | Note |", "|---|---|---|---|", ...rows, ""].join("\n"));
}

async function main() {
  const config = loadConfig();
  const secrets = loadSecrets();
  // `||` not `??`: a workflow_dispatch input left empty arrives as "" and Number("") is 0.
  const sinceHours = Number(process.env.CAPTURE_SINCE_HOURS || config.slack.since_hours);
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    throw new Error(`CAPTURE_SINCE_HOURS must be a positive number, got "${process.env.CAPTURE_SINCE_HOURS}"`);
  }
  const channel = config.slack.channel_id;
  log(`[capture] channel=${channel} window=${sinceHours}h mode=${DRY_RUN ? "DRY-RUN (creates nothing)" : "LIVE"}`);

  const slack = new SlackClient(secrets.slackBotToken, log);
  const jira = new JiraClient(config.jira.site, secrets.atlassianEmail, secrets.atlassianApiToken, log);

  const oldest = Math.floor(Date.now() / 1000 - sinceHours * 3600);
  const messages = await slack.history(channel, oldest);
  const candidates: Candidate[] = [];
  for (const msg of messages) {
    const reaction = detectReaction(msg);
    if (reaction) candidates.push({ msg, reaction, parsed: parseMessage(msg), label: slackTsLabel(msg.ts) });
  }
  log(`[scan] ${messages.length} messages in window, ${candidates.length} with a 💡/🐛 reaction`);
  if (candidates.length === 0) {
    log("No candidates.");
    return;
  }

  // Two independent markers: the Jira label set at creation, and the Slack
  // reply posted afterwards. Either one means "already filed".
  const filedInJira = await jira.findLabels(candidates.map((c) => c.label));
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (filedInJira.has(c.label)) continue;
    if (await slack.hasConfirmation(channel, c.msg.ts)) continue;
    fresh.push(c);
  }
  log(`[dedup] ${candidates.length} candidates, ${candidates.length - fresh.length} already filed, ${fresh.length} fresh`);
  if (fresh.length === 0) {
    log("Nothing new to file.");
    return;
  }

  const outcomes: Outcome[] = [];
  const filedThisRun = new Set<string>();
  for (const c of fresh) {
    if (filedThisRun.has(c.msg.ts)) continue;
    const kind = c.reaction === "bulb" ? "Idea" : "Bug";
    try {
      const draft = await prepare(c, config, slack);
      if (VERBOSE) {
        const area = draft.productArea ? ` [${draft.productArea.name}]` : "";
        log(`  ${icon(c.reaction)} ${c.parsed.source.padEnd(8)} "${draft.title}"${area} by ${draft.author}`);
        log(`     ${draft.permalink}`);
      }
      if (DRY_RUN) continue;

      const { key, url, dropped } = await jira.createIssue(draft.fields, draft.optionalFieldIds);
      if (dropped.length > 0) log(`   fields not accepted by Jira and left empty: ${dropped.join(", ")}`);
      filedThisRun.add(c.msg.ts);
      try {
        await withRetry(
          () => slack.postThreadReply(channel, c.msg.ts, confirmationText(kind, key, url, draft.title)),
          { label: "slack reply", log },
        );
        outcomes.push({ reaction: c.reaction, status: "created", key });
        log(`${icon(c.reaction)} → ${key}`);
      } catch (err) {
        // The issue exists and carries its label, so the next run will not
        // re-file it. Still a failure: the submitter never got their reply.
        outcomes.push({ reaction: c.reaction, status: "created_no_reply", key, error: errorMessage(err) });
        log(`${icon(c.reaction)} → ${key} (created, but the Slack reply failed: ${errorMessage(err)})`);
      }
    } catch (err) {
      outcomes.push({ reaction: c.reaction, status: "failed", error: errorMessage(err) });
      log(`${icon(c.reaction)} → FAILED: ${errorMessage(err)}`);
    }
  }

  if (DRY_RUN) {
    log(`Dry run: ${fresh.length} would be filed. Nothing was created.`);
    return;
  }
  writeStepSummary(outcomes);
  const problems = outcomes.filter((o) => o.status !== "created");
  if (problems.length > 0) {
    log(`${problems.length} of ${outcomes.length} need attention.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nCapture aborted: ${errorMessage(err)}`);
  console.error(
    "Nothing is lost: reactions stay in the channel and the next run picks them up, as long as it happens inside the look-back window.",
  );
  process.exit(2);
});
