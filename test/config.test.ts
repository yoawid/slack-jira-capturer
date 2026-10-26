import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { channelIds, loadSecrets, parseConfig } from "../config.ts";

const example = readFileSync(new URL("../capture.config.example.json", import.meta.url), "utf8");

test("the committed example config is valid", () => {
  const cfg = parseConfig(example, "example");
  assert.equal(cfg.slack.since_hours, 168);
  assert.equal(cfg.jira.idea.product_area?.default_for_ybug, "User interfaces");
});

test("config errors name the offending key", () => {
  assert.throws(() => parseConfig("{", "x"), /not valid JSON/);
  assert.throws(() => parseConfig(JSON.stringify({ slack: {}, jira: {} }), "x"), /channel_id/);
  const bad = JSON.parse(example);
  bad.jira.idea.product_area.default_for_ybug = "Nope";
  assert.throws(() => parseConfig(JSON.stringify(bad), "x"), /default_for_ybug "Nope"/);
});

test("secrets: every missing variable is named", () => {
  assert.throws(() => loadSecrets({}), /SLACK_BOT_TOKEN/);
  assert.throws(() => loadSecrets({ SLACK_BOT_TOKEN: "x" }), /ATLASSIAN_EMAIL/);
  assert.deepEqual(loadSecrets({ SLACK_BOT_TOKEN: "a", ATLASSIAN_EMAIL: "b", ATLASSIAN_API_TOKEN: "c" }), {
    slackBotToken: "a",
    atlassianEmail: "b",
    atlassianApiToken: "c",
  });
});

test("channels: the old single key still works, a list adds to it, duplicates collapse", () => {
  const base = JSON.parse(example);
  assert.deepEqual(channelIds(parseConfig(JSON.stringify(base), "x")), ["C0XXXXXXXXX"]);
  base.slack.channel_ids = ["C0YYYYYYYYY", "C0XXXXXXXXX"];
  assert.deepEqual(channelIds(parseConfig(JSON.stringify(base), "x")), ["C0XXXXXXXXX", "C0YYYYYYYYY"]);
  delete base.slack.channel_id;
  assert.deepEqual(channelIds(parseConfig(JSON.stringify(base), "x")), ["C0YYYYYYYYY", "C0XXXXXXXXX"]);
  base.slack.channel_ids = [];
  assert.throws(() => parseConfig(JSON.stringify(base), "x"), /channel_id/);
  base.slack.channel_ids = ["not-a-channel"];
  assert.throws(() => parseConfig(JSON.stringify(base), "x"), /channel ID/);
});
