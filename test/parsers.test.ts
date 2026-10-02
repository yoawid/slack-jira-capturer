import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { adf, slackTsLabel, tsFromLabel } from "../jira.ts";
import {
  buildDescription,
  deriveTitle,
  detectReaction,
  mapProductArea,
  mentionedUserIds,
  parseMessage,
  parseTemplate,
  parseYbug,
  reactorsOf,
  stripSlackMarkup,
  truncate,
} from "../parsers.ts";
import type { SlackMessage } from "../slack.ts";

const fixture = (name: string): SlackMessage =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as SlackMessage;

const OPTIONS = {
  "User interfaces": "11",
  "Smart control": "12",
  Integrations: "13",
  "Reporting & Insights": "14",
};

test("detectReaction: bug beats bulb, aliases count, nothing else does", () => {
  assert.equal(detectReaction(fixture("ybug")), "bug");
  assert.equal(detectReaction(fixture("template-single")), "bulb");
  assert.equal(detectReaction(fixture("template-multi")), "bulb"); // light_bulb alias
  assert.equal(detectReaction(fixture("both-reactions")), "bug");
  assert.equal(detectReaction({ ts: "1.0", reactions: [{ name: "eyes" }] }), null);
  assert.equal(detectReaction({ ts: "1.0" }), null);
});

test("reactorsOf returns the users of the matching reaction only", () => {
  assert.deepEqual(reactorsOf(fixture("both-reactions"), "bug"), ["U0000000006"]);
  assert.deepEqual(reactorsOf(fixture("both-reactions"), "bulb"), ["U0000000005"]);
});

test("parseYbug strips the [project] prefix and takes the Summary field as body", () => {
  const parsed = parseYbug(fixture("ybug"));
  assert.ok(parsed);
  assert.equal(parsed.title, "#42 Button does nothing on save");
  assert.match(parsed.body, /^Clicking Save/);
  assert.equal(parseYbug(fixture("generic")), null);
});

test("parseTemplate reads every form field from a single-product post", () => {
  const parsed = parseTemplate(fixture("template-single").text!);
  assert.ok(parsed);
  assert.equal(parsed.preTitle, "Show owning company on the building page");
  assert.deepEqual(parsed.productValues, ["User interfaces"]);
  assert.equal(parsed.type, "Idea");
  assert.equal(parsed.impact, 3);
  assert.equal(parsed.body, "Can we show which company a building belongs to?");
  assert.equal(parsed.submitterId, "U0000000001");
});

test("parseTemplate splits multi-value Product, unescapes &amp;, keeps multi-line details", () => {
  const parsed = parseTemplate(fixture("template-multi").text!);
  assert.ok(parsed);
  assert.deepEqual(parsed.productValues, ["Smart Control", "Reporting & Insights"]);
  assert.equal(parsed.impact, 4);
  assert.equal(parsed.submitterId, "U0000000001"); // mention carried a |label
  assert.equal(parsed.body.split("\n").length, 2);
});

test("parseTemplate takes the submitter from the header, not from a mention in Details", () => {
  const parsed = parseTemplate(fixture("template-mention-in-details").text!);
  assert.ok(parsed);
  assert.equal(parsed.submitterId, "U0000000001");
  assert.deepEqual(mentionedUserIds(parsed.body), ["U0000000009"]);
});

test("parseTemplate ignores messages without the form markers", () => {
  assert.equal(parseTemplate("just chatting about submitted feedback"), null);
  assert.equal(parseTemplate(fixture("generic").text!), null);
});

test("parseMessage picks ybug, then template, then generic", () => {
  assert.equal(parseMessage(fixture("ybug")).source, "ybug");
  assert.equal(parseMessage(fixture("template-single")).source, "template");
  assert.equal(parseMessage(fixture("generic")).source, "generic");
  assert.equal(parseMessage({ ts: "1.0", text: "" }).body, "(no text content)");
});

test("stripSlackMarkup resolves mentions, unwraps links, unescapes entities", () => {
  const names = new Map([["U0000000004", "Alex Example"]]);
  const clean = stripSlackMarkup(fixture("generic").text!, names);
  assert.equal(
    clean,
    "Suggestion: let @Alex Example and I try the new changelog format for release notes.\n" +
      "Second line with a bare link https://example.com/x & an ampersand.",
  );
  assert.equal(stripSlackMarkup("<@U0000000001|Sam> in <#C0000000001|general> <!here>"), "@Sam in #general @here");
  assert.equal(stripSlackMarkup("<@U0000000001>"), "@U0000000001"); // unknown, no label
});

test("deriveTitle: ybug gets a prefix, template is verbatim, generic is the first line", () => {
  assert.equal(deriveTitle("ybug", "#42 Button does nothing on save", ""), "Ybug - #42 Button does nothing on save");
  assert.equal(deriveTitle("template", "Show owning company", "ignored"), "Show owning company");
  assert.equal(deriveTitle("generic", undefined, "\n\n• First real line\nSecond"), "First real line");
  assert.equal(deriveTitle("generic", undefined, ""), "(untitled)");
});

test("deriveTitle caps at 80 characters on one line", () => {
  const long = "word ".repeat(40).trim();
  const title = deriveTitle("generic", undefined, long);
  assert.equal(title.length, 80);
  assert.ok(title.endsWith("…"));
  assert.ok(!/\n/.test(deriveTitle("template", "two\nlines", "")));
  assert.equal(truncate("short", 80), "short");
});

test("mapProductArea: first submitted value that matches wins; tolerant matching", () => {
  assert.deepEqual(mapProductArea(["Smart Control", "Reporting & Insights"], OPTIONS), {
    name: "Smart control",
    option_id: "12",
  });
  assert.equal(mapProductArea(["reporting and insights"], OPTIONS)?.option_id, "14");
  assert.equal(mapProductArea(["Reporting &amp; Insights"], OPTIONS)?.option_id, "14");
  assert.equal(mapProductArea(["Something else", "Integrations"], OPTIONS)?.option_id, "13");
  assert.equal(mapProductArea(["Something else"], OPTIONS), null);
  assert.equal(mapProductArea([], OPTIONS), null);
});

test("buildDescription appends author, permalink and submitted form values", () => {
  const text = buildDescription({
    body: "Body text",
    author: "Sam Example",
    permalink: "https://example.slack.com/archives/C1/p1700000001000200",
    productValues: ["Smart Control", "Reporting & Insights"],
    type: "Pain point",
    impact: 4,
    productAreaUnmapped: false,
  });
  assert.match(text, /^Body text\n\n---\n\nAuthor: Sam Example\nSlack: https:/);
  assert.match(text, /Product \(as submitted\): Smart Control, Reporting & Insights/);
  assert.match(text, /Type: Pain point\nImpact: 4$/);
  assert.match(buildDescription({ body: "", author: "A", permalink: "p", productAreaUnmapped: true }), /could not be mapped/);
});

test("adf: paragraphs, hard breaks, rule and links", () => {
  const doc = adf("Line one\nLine two\n\n---\n\nSee https://example.com/x. Done");
  assert.equal(doc.content.length, 3);
  const [p1, rule, p2] = doc.content as [any, any, any];
  assert.equal(p1.type, "paragraph");
  assert.deepEqual(
    p1.content.map((n: any) => n.type),
    ["text", "hardBreak", "text"],
  );
  assert.equal(rule.type, "rule");
  const link = p2.content.find((n: any) => n.marks);
  assert.equal(link.text, "https://example.com/x");
  assert.equal(link.marks[0].attrs.href, "https://example.com/x");
  assert.equal(p2.content.at(-1).text, ". Done");
  assert.equal(adf("").content[0]!.type, "paragraph");
});

test("dedup label round-trips a Slack ts", () => {
  assert.equal(slackTsLabel("1700000001.000200"), "slack-ts-1700000001-000200");
  assert.equal(tsFromLabel("slack-ts-1700000001-000200"), "1700000001.000200");
  assert.equal(tsFromLabel("something-else"), null);
});

test("confirmation text is recognised by the dedup regex, old and new wording alike", async () => {
  const { CONFIRMATION_RE, confirmationText } = await import("../slack.ts");
  assert.match(confirmationText("Idea", "PROJ-1", "https://x/browse/PROJ-1", "T & <t>"), /Created an Idea from this message: <https:\/\/x\/browse\/PROJ-1\|PROJ-1: T &amp; &lt;t&gt;>/);
  assert.match(confirmationText("Bug", "BUG-2", "https://x/browse/BUG-2", "t"), /Created a Bug from this message:/);
  assert.match(":robot_face: Created a Idea from this message: <u|k: t>  •  Status: *Investigate*", CONFIRMATION_RE); // legacy replies
  assert.doesNotMatch("Created an issue from this message:", CONFIRMATION_RE);
});
