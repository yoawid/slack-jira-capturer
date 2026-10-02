// Slack Web API client: paginated reads, cached user lookup, threaded replies.
// Credentials are read by the caller and passed in; nothing here touches env.
import { RetryableError, withRetry } from "./retry.ts";

export type SlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  thread_ts?: string;
  reactions?: { name: string; users?: string[]; count?: number }[];
  attachments?: {
    title?: string;
    text?: string;
    footer?: string;
    fallback?: string;
    fields?: { title: string; value: string }[];
  }[];
};

// The threaded reply posted after filing, and the regex that recognises it on
// later runs. They live together so one cannot drift from the other. Replies
// posted by earlier versions of this tool match the same regex.
export const CONFIRMATION_RE = /Created an? (Bug|Idea) from this message:/;

export function confirmationText(kind: "Idea" | "Bug", key: string, url: string, title: string): string {
  const label = `${key}: ${title}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const article = kind === "Idea" ? "an" : "a";
  return `:robot_face: Created ${article} ${kind} from this message: <${url}|${label}>`;
}

type Envelope = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } };
type Page = Envelope & { messages?: SlackMessage[]; has_more?: boolean };

const RETRYABLE_ERRORS = new Set(["ratelimited", "internal_error", "service_unavailable", "fatal_error"]);

export class SlackClient {
  private readonly names = new Map<string, string>();

  constructor(
    private readonly token: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  private async call<T extends object>(
    method: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<T & Envelope> {
    return withRetry(
      async () => {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
        let resp: Response;
        if (body) {
          headers["Content-Type"] = "application/json; charset=utf-8";
          resp = await fetch(`https://slack.com/api/${method}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
        } else {
          resp = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers });
        }
        if (resp.status === 429 || resp.status >= 500) {
          const retryAfter = Number(resp.headers.get("retry-after"));
          throw new RetryableError(
            `Slack ${method} → HTTP ${resp.status}`,
            retryAfter > 0 ? retryAfter * 1000 : undefined,
          );
        }
        const json = (await resp.json()) as T & Envelope;
        if (!json.ok) {
          const message = `Slack ${method} failed: ${json.error ?? "unknown error"}`;
          if (RETRYABLE_ERRORS.has(json.error ?? "")) throw new RetryableError(message);
          throw new Error(message);
        }
        return json;
      },
      { label: `slack.${method}`, log: this.log },
    );
  }

  private nextCursor(page: Page): string | undefined {
    return page.has_more ? page.response_metadata?.next_cursor || undefined : undefined;
  }

  /** Top-level channel messages newer than `oldestUnix`, oldest first, across all pages. */
  async history(channel: string, oldestUnix: number, cap = 2000): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<Page>("conversations.history", {
        channel,
        oldest: String(oldestUnix),
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...(page.messages ?? []));
      cursor = this.nextCursor(page);
    } while (cursor && messages.length < cap);
    if (cursor) this.log(`[slack] stopped after ${cap} messages; the window holds more than that`);
    // ts strings share one format ("1700000000.000100"), so lexical order is chronological.
    return messages.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** True when this tool's confirmation reply already sits in the message's thread. */
  async hasConfirmation(channel: string, ts: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const page = await this.call<Page>("conversations.replies", {
        channel,
        ts,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      for (const m of page.messages ?? []) {
        if (m.ts !== ts && m.text && CONFIRMATION_RE.test(m.text)) return true;
      }
      cursor = this.nextCursor(page);
    } while (cursor);
    return false;
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const r = await this.call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts });
    return r.permalink;
  }

  /** Display name for a user ID; falls back to the ID for deleted or external users. */
  async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const r = await this.call<{ user: { real_name?: string; name?: string } }>("users.info", { user: userId });
      name = r.user.real_name ?? r.user.name ?? userId;
    } catch (err) {
      this.log(`[slack] could not resolve ${userId}: ${(err as Error).message}`);
    }
    this.names.set(userId, name);
    return name;
  }

  async postThreadReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.call("chat.postMessage", {}, { channel, thread_ts: threadTs, text, unfurl_links: false });
  }
}
