import assert from "node:assert/strict";
import { test } from "node:test";
import { JiraClient } from "../jira.ts";
import { RetryableError, withRetry } from "../retry.ts";
import { SlackClient } from "../slack.ts";

const noSleep = async () => {};

/** Replace global fetch for one test; each call pops the next scripted response. */
function scriptFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length}: ${String(url)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("withRetry retries RetryableError with the hinted delay, gives up after N attempts", async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new RetryableError("try again", calls === 1 ? 5000 : undefined);
      return "ok";
    },
    { label: "t", attempts: 3, sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(result, "ok");
  assert.deepEqual(waits, [5000, 2000]); // hinted, then 1000 * 2^(attempt-1)

  await assert.rejects(
    withRetry(async () => { throw new RetryableError("always"); }, { label: "t", attempts: 2, sleep: noSleep }),
    /always/,
  );
  let plain = 0;
  await assert.rejects(
    withRetry(async () => { plain++; throw new Error("bad request"); }, { label: "t", sleep: noSleep }),
    /bad request/,
  );
  assert.equal(plain, 1); // non-retryable errors are not repeated
});

test("createIssue drops a rejected optional field and retries once", async () => {
  const f = scriptFetch([
    { status: 400, body: { errorMessages: [], errors: { customfield_10003: "Rating out of range" } } },
    { status: 201, body: { key: "PROJ-7" } },
  ]);
  try {
    const jira = new JiraClient("example.atlassian.net", "me@example.com", "token");
    const result = await jira.createIssue(
      { summary: "t", customfield_10003: 9, customfield_10002: { id: "1" } },
      ["customfield_10003", "customfield_10002"],
    );
    assert.deepEqual(result, { key: "PROJ-7", url: "https://example.atlassian.net/browse/PROJ-7", dropped: ["customfield_10003"] });
    assert.equal(f.calls.length, 2);
    const second = JSON.parse(f.calls[1]!.init!.body as string);
    assert.equal(second.fields.customfield_10003, undefined);
    assert.deepEqual(second.fields.customfield_10002, { id: "1" });
  } finally {
    f.restore();
  }
});

test("createIssue does not retry when a required field is the problem", async () => {
  const f = scriptFetch([{ status: 400, body: { errors: { summary: "required" } } }]);
  try {
    const jira = new JiraClient("example.atlassian.net", "me@example.com", "token");
    await assert.rejects(jira.createIssue({ customfield_1: 1 }, ["customfield_1"]), /HTTP 400/);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("findLabels follows nextPageToken and reports only labels that were asked for", async () => {
  const f = scriptFetch([
    { status: 200, body: { issues: [{ fields: { labels: ["slack-ts-1-1", "other"] } }], nextPageToken: "p2" } },
    { status: 200, body: { issues: [{ fields: { labels: ["slack-ts-2-2"] } }] } },
  ]);
  try {
    const jira = new JiraClient("example.atlassian.net", "me@example.com", "token");
    const found = await jira.findLabels(["slack-ts-1-1", "slack-ts-2-2", "slack-ts-3-3"]);
    assert.deepEqual([...found].sort(), ["slack-ts-1-1", "slack-ts-2-2"]);
    assert.equal(f.calls.length, 2);
    assert.match(JSON.parse(f.calls[0]!.init!.body as string).jql, /^labels in \("slack-ts-1-1", "slack-ts-2-2", "slack-ts-3-3"\)$/);
  } finally {
    f.restore();
  }
});

test("Slack history paginates and returns oldest first; 429 is retried", async () => {
  const f = scriptFetch([
    { status: 429, body: {}, headers: { "retry-after": "1" } },
    { status: 200, body: { ok: true, messages: [{ ts: "3.0" }, { ts: "2.0" }], has_more: true, response_metadata: { next_cursor: "c2" } } },
    { status: 200, body: { ok: true, messages: [{ ts: "1.0" }], has_more: false } },
  ]);
  try {
    // Swap the retry sleep by monkey-patching setTimeout would be invasive; a 1 s wait is acceptable here.
    const slack = new SlackClient("xoxb-test");
    const messages = await slack.history("C1", 0);
    assert.deepEqual(messages.map((m) => m.ts), ["1.0", "2.0", "3.0"]);
    assert.equal(f.calls.length, 3);
    assert.match(f.calls[2]!.url, /cursor=c2/);
  } finally {
    f.restore();
  }
});

test("Slack non-retryable API errors surface the Slack error code", async () => {
  const f = scriptFetch([{ status: 200, body: { ok: false, error: "channel_not_found" } }]);
  try {
    const slack = new SlackClient("xoxb-test");
    await assert.rejects(slack.history("C1", 0), /channel_not_found/);
  } finally {
    f.restore();
  }
});
