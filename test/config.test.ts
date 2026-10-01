import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadSecrets, parseConfig } from "../config.ts";

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
