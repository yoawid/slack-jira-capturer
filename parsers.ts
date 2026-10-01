// Pure functions: how a Slack message becomes a title, a body and a set of
// Jira field values. No I/O, so everything here is unit-tested with fixtures.
import type { SlackMessage } from "./slack.ts";

export type Reaction = "bulb" | "bug";
export type Source = "ybug" | "template" | "generic";

const BULB_NAMES = ["bulb", "light_bulb"];
const BUG_NAMES = ["bug"];

/** 🐛 wins when a message carries both: a bug report is the more specific claim. */
export function detectReaction(msg: SlackMessage): Reaction | null {
  const names = new Set((msg.reactions ?? []).map((r) => r.name));
  if (BUG_NAMES.some((n) => names.has(n))) return "bug";
  if (BULB_NAMES.some((n) => names.has(n))) return "bulb";
  return null;
}

export function reactorsOf(msg: SlackMessage, reaction: Reaction): string[] {
  const wanted = reaction === "bug" ? BUG_NAMES : BULB_NAMES;
  return msg.reactions?.find((r) => wanted.includes(r.name))?.users ?? [];
}

export type Parsed = {
  source: Source;
  /** Title taken from the message itself (Ybug or form). Generic messages have none. */
  preTitle?: string;
  /** Raw body, still with Slack markup. */
  body: string;
  /** "Product" values exactly as submitted in the form, in order. */
  productValues: string[];
  type?: string;
  impact?: number;
  /** User ID named in the form header; the form is posted by a workflow, so msg.user is empty. */
  submitterId?: string;
};

// Ybug posts a bot_message whose first attachment carries the report.
export function parseYbug(msg: SlackMessage): { title: string; body: string } | null {
  const a = msg.attachments?.[0];
  if (!a || a.footer !== "Reported via Ybug") return null;
  // Title example: "[Example App] #42 Button does nothing on save"
  const title = (a.title ?? "").replace(/^\[[^\]]+\]\s*/, "").trim();
  const summary = a.fields?.find((f) => f.title === "Summary")?.value ?? "";
  return { title: title || "Ybug report", body: summary || a.title || "" };
}

// Slack Workflow Builder form: "<@U…> - submitted feedback" followed by bullet fields.
export function parseTemplate(text: string): Omit<Parsed, "source"> | null {
  if (!/submitted feedback/i.test(text)) return null;
  const field = (label: string) =>
    text.match(new RegExp(`^[ \\t]*(?:[•*\\-–]\\s*)?${label}:[ \\t]*(.+)$`, "im"))?.[1]?.trim();
  const title = field("Title");
  if (!title) return null;
  const productValues =
    field("Product")
      ?.split(",")
      .map((v) => v.replace(/&amp;/g, "&").trim())
      .filter(Boolean) ?? [];
  const impactRaw = field("Impact");
  const impact = impactRaw !== undefined && /^\d+$/.test(impactRaw) ? Number(impactRaw) : undefined;
  const details = text.match(/Details:[ \t]*\n?([\s\S]*)$/i)?.[1]?.trim() ?? "";
  // Anchored to the header line so a mention inside Details cannot win.
  const submitterId = text.match(/^\s*<@([UW][A-Z0-9]+)(?:\|[^>]*)?>[^\n]*submitted feedback/i)?.[1];
  return {
    preTitle: title,
    body: details || title,
    productValues,
    type: field("Type"),
    impact,
    submitterId,
  };
}

export function extractGenericText(msg: SlackMessage): string {
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

export function parseMessage(msg: SlackMessage): Parsed {
  const ybug = parseYbug(msg);
  if (ybug) return { source: "ybug", preTitle: ybug.title, body: ybug.body, productValues: [] };
  const template = parseTemplate(msg.text ?? "");
  if (template) return { source: "template", ...template };
  return { source: "generic", body: extractGenericText(msg), productValues: [] };
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;

export function mentionedUserIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]!))];
}

/** Slack mrkdwn → plain text. Mentions become @Name when a name is known. */
export function stripSlackMarkup(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  return text
    .replace(MENTION_RE, (_m, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(channel|here|everyone)>/g, "@$1")
    .replace(/<([^>|]+)\|([^>]*)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.replace(/^[\s>•*\-–]+/, "").trim();
    if (t) return t;
  }
  return "";
}

/** Jira summary: one line, at most `max` characters. */
export function deriveTitle(source: Source, preTitle: string | undefined, cleanBody: string, max = 80): string {
  let raw: string;
  if (source === "ybug") raw = `Ybug - ${preTitle ?? "report"}`;
  else if (source === "template") raw = preTitle ?? firstLine(cleanBody);
  else raw = firstLine(cleanBody);
  return truncate(raw.replace(/\s+/g, " ").trim(), max) || "(untitled)";
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\band\b/g, "&")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * First submitted value that names a known option wins. Case, "&" vs "and",
 * punctuation and Slack's `&amp;` escaping are ignored. Null when nothing matches.
 */
export function mapProductArea(
  values: string[],
  options: Record<string, string>,
): { name: string; option_id: string } | null {
  const byNorm = new Map(Object.entries(options).map(([name, id]) => [normalise(name), { name, option_id: id }]));
  for (const v of values) {
    const hit = byNorm.get(normalise(v));
    if (hit) return hit;
  }
  return null;
}

export function buildDescription(args: {
  body: string;
  author: string;
  permalink: string;
  productValues?: string[];
  type?: string;
  impact?: number;
  productAreaUnmapped?: boolean;
}): string {
  const meta = [`Author: ${args.author}`, `Slack: ${args.permalink}`];
  if (args.productValues?.length) meta.push(`Product (as submitted): ${args.productValues.join(", ")}`);
  if (args.type) meta.push(`Type: ${args.type}`);
  if (args.impact !== undefined) meta.push(`Impact: ${args.impact}`);
  if (args.productAreaUnmapped) meta.push("Product area could not be mapped automatically; please set it.");
  return `${args.body.trim() || "(no text content)"}\n\n---\n\n${meta.join("\n")}`;
}
