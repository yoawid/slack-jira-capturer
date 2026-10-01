# slack-jira-capturer

React to a Slack message with 💡 and it becomes an idea in Jira Product Discovery. React with 🐛 and it becomes a bug in a Jira Software project. The tool replies in the thread with a link, runs once a day on GitHub Actions, and costs nothing to operate.

This is the third version. The first two had a language model in the loop. This one does not, and the reason why is the most useful thing in this repository.

## The short version

I built an agent to triage product feedback from Slack into Jira. It ran for fourteen weeks. In that time it filed sixteen tickets, and for fifteen of them the title was already written by a human in a form or by a bug-reporting widget. The model's genuine contributions were one title, three product-area guesses and four tie-breaks between product areas a submitter had picked. Every one of those is now a rule in [parsers.ts](parsers.ts). The model is gone, and with it the only component that ever caused an outage.

## The numbers

| | |
|---|---|
| Period observed | 5 May to 13 Aug 2026 (14 weeks), then 7 more weeks of daily runs |
| Messages filed | 16 (13 ideas, 3 bugs), plus 2 duplicates from one incident |
| Source of those messages | 10 from a Slack Workflow form, 5 from the Ybug widget, 1 free-text chat message |
| Items where the model wrote the title | 1 |
| Items where the model chose the product area from text | 3 (two Ybug reports, the free-text message) |
| Items where the model picked one of several submitted product areas | 4 |
| Daily runs after the last reaction | 48 consecutive runs that found nothing, each spinning up a model session |
| Incidents | 2: a four-day outage when API credits ran out, and a double-filing race |

Three tickets a month is roughly an hour of manual work per quarter. The automation was never going to pay for itself in saved clicks. It paid for itself as an experiment with a clear result, and the result was "not here".

## Three versions, three lessons

**v1, Managed Agents (May 2026).** A hosted agent with host-side custom tools, so Slack and Jira credentials never entered the sandbox. Billing ran on a personal API organisation. When its prepaid credits hit zero the cron failed silently for four days. Lesson: a chat subscription and API credits are separate ledgers, and topping up the wrong one looks exactly like topping up the right one until the next run fails.

**v2, Claude Agent SDK (August 2026).** Same tools, now in-process, authenticated with a personal subscription token instead of API credits. Two manual runs started seven seconds apart. Dedup worked by looking for the bot's own confirmation reply in the Slack thread, which only exists after the ticket is created, so both runs saw "not filed yet" and both filed. Lesson: a marker that appears after the side effect is not an idempotency key. The fix was to queue concurrent runs rather than cancel them, because cancelling one between creating the issue and posting the reply would leave a ticket dedup could never see.

**v3, this one (October 2026).** Plain TypeScript. The dedup marker is now a Jira label set in the create request itself, with the Slack reply kept as a second, independent signal. Slack history is paginated, where before a `limit=200` silently dropped the oldest part of a busy week. Transport errors are retried. A failed ticket makes the run exit non-zero so somebody actually hears about it. There is nothing left for a model to decide.

## The alternative I considered

The Jira Cloud for Slack app already has a "Create issue from" message shortcut, and it works for Product Discovery ideas. Two reasons it did not replace this tool: the people submitting the feedback form mostly do not have Jira seats, and a product manager triaging a channel wants one emoji per message, not one modal per message. If neither applies to you, use the shortcut and skip all of this.

## How it works

```
   Slack channel                 GitHub Actions (daily)                   Jira
        │                                 │                                 ▲
   💡 / 🐛 reaction                       │  1. read history (paginated)    │
        │                                 │  2. parse: Ybug / form / text   │
        └────────────────────────────────►│  3. dedup: Jira label           │
                                          │           + Slack reply         │
        ◄── threaded reply ───────────────│  4. create issue + label ───────┘
                                          │  5. reply in thread
```

| Slack source | How it is recognised | Title | Product area |
|---|---|---|---|
| Ybug widget | `bot_message` with footer `Reported via Ybug` | `Ybug - <report title>` | A configured default, since widget reports never state one |
| Workflow form | text contains `submitted feedback` and a `Title:` bullet | Title field verbatim | First submitted value that matches a configured option. All values go into the description. |
| Anything else | fallback | First line of the message, max 80 characters | Left empty for the triager |

Bugs skip product area. Every issue gets a label `slack-ts-<timestamp>` and a description ending in the author, the Slack permalink and the form's own Type and Impact. When the form's Impact is 1 to 5 it is also written to a Polaris rating field if one is configured.

## Run it yourself

Requirements: Node 22, a Slack app with a bot token, an Atlassian API token.

```sh
npm ci
cp capture.config.example.json capture.config.json   # channel, project keys, field IDs
cp .env.example .env                                  # the three secrets
npm run capture:dry                                   # reads, dedups, prints, creates nothing
npm run capture                                       # files tickets
```

Finding your IDs: `GET /rest/api/3/issue/createmeta/{projectKey}/issuetypes/{issueTypeId}` lists field IDs and option IDs. The Slack channel ID is in the channel's "About" panel.

Slack bot scopes: `channels:history`, `groups:history` (private channels), `reactions:read`, `users:read`, `chat:write`. Invite the bot to the channel. After changing scopes, reinstall the app.

### Deploying

The workflow in [.github/workflows/capture-ideas.yml](.github/workflows/capture-ideas.yml) runs daily at 04:47 UTC, or on demand. It is gated on a repository variable, `CAPTURE_ENABLED=true`, and reads the config from another variable, `CAPTURE_CONFIG_JSON`. Secrets `SLACK_BOT_TOKEN`, `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` come from repository secrets.

Run it from a **private** repository. GitHub Actions logs in a public repository are readable by anyone, and even with titles suppressed the logs show issue keys and volume. The intended setup is this public repository for the code and a private fork, with the variables and secrets, for production. Keep the fork current with `git pull upstream main`.

Two GitHub behaviours worth knowing: scheduled workflows in public repositories are disabled after 60 days without a commit, and cron triggers routinely fire hours late. Neither matters for a daily triage inbox once the runner is private.

## Known limits

- Reactions on replies inside a thread are not seen; only top-level messages are scanned.
- The look-back window (`since_hours`, default 168) bounds how late a reaction can be added and still be picked up.
- Tickets filed by earlier versions carry no label; for those, dedup relies on the Slack reply alone.
- Only `:bulb:`, `:light_bulb:` and `:bug:` count. When a message has both, bug wins.
- Jira's search index lags creation by a few seconds. Two runs seconds apart are serialised by the workflow's concurrency group; two separate deployments pointed at the same channel are not.

## Development

```sh
npm run typecheck
npm test
```

Parsers are pure functions tested against anonymised fixtures in [test/fixtures](test/fixtures). Everything that talks to a network lives in [slack.ts](slack.ts) and [jira.ts](jira.ts).
