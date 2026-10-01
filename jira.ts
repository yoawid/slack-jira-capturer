// Jira Cloud REST client plus the two small pieces of shared vocabulary:
// the dedup label derived from a Slack timestamp, and the ADF builder.
import { RetryableError, withRetry } from "./retry.ts";

export type AdfNode = { type: string; [key: string]: unknown };
export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

export class JiraClient {
  private readonly auth: string;

  constructor(
    readonly site: string,
    email: string,
    apiToken: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return withRetry(
      async () => {
        const resp = await fetch(`https://${this.site}${path}`, {
          method,
          headers: {
            Authorization: this.auth,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await resp.text();
        if (resp.status === 429 || resp.status >= 500) {
          const retryAfter = Number(resp.headers.get("retry-after"));
          throw new RetryableError(
            `Jira ${method} ${path} → HTTP ${resp.status}`,
            retryAfter > 0 ? retryAfter * 1000 : undefined,
          );
        }
        if (!resp.ok) throw new Error(`Jira ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 600)}`);
        return (text ? JSON.parse(text) : null) as T;
      },
      { label: `jira ${method} ${path}`, log: this.log },
    );
  }

  /**
   * Create an issue. When Jira rejects one of the `optionalFieldIds` (a Polaris
   * rating that only takes certain values, an option that was renamed), the
   * field is dropped and the request repeated once: a filed issue missing a
   * nice-to-have field beats a run that fails every day until someone notices.
   */
  async createIssue(
    fields: Record<string, unknown>,
    optionalFieldIds: string[] = [],
  ): Promise<{ key: string; url: string; dropped: string[] }> {
    const dropped: string[] = [];
    const attempt = { ...fields };
    for (;;) {
      try {
        const r = await this.call<{ key: string }>("POST", "/rest/api/3/issue", { fields: attempt });
        return { key: r.key, url: `https://${this.site}/browse/${r.key}`, dropped };
      } catch (err) {
        const rejected = rejectedFields(err).filter((id) => optionalFieldIds.includes(id) && id in attempt);
        if (rejected.length === 0) throw err;
        for (const id of rejected) delete attempt[id];
        dropped.push(...rejected);
        this.log(`[jira] dropped field(s) ${rejected.join(", ")} after: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  }

  /** Which of the given labels already exist on any issue. One query per 50 labels. */
  async findLabels(labels: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < labels.length; i += 50) {
      const chunk = labels.slice(i, i + 50);
      const wanted = new Set(chunk);
      const jql = `labels in (${chunk.map((l) => `"${l}"`).join(", ")})`;
      let nextPageToken: string | undefined;
      do {
        const page = await this.call<{
          issues?: { fields?: { labels?: string[] } }[];
          nextPageToken?: string;
        }>("POST", "/rest/api/3/search/jql", {
          jql,
          fields: ["labels"],
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
        for (const issue of page.issues ?? []) {
          for (const label of issue.fields?.labels ?? []) if (wanted.has(label)) found.add(label);
        }
        nextPageToken = page.nextPageToken;
      } while (nextPageToken);
    }
    return found;
  }
}

function rejectedFields(err: unknown): string[] {
  const match = /HTTP 400: (\{[\s\S]*\})$/.exec((err as Error).message ?? "");
  if (!match) return [];
  try {
    const body = JSON.parse(match[1]!) as { errors?: Record<string, string> };
    return Object.keys(body.errors ?? {});
  } catch {
    return [];
  }
}

// Jira labels cannot contain spaces; dots are legal but a dash reads better.
export const slackTsLabel = (ts: string): string => `slack-ts-${ts.replace(".", "-")}`;

export function tsFromLabel(label: string): string | null {
  const m = /^slack-ts-(\d+)-(\d+)$/.exec(label);
  return m ? `${m[1]}.${m[2]}` : null;
}

const URL_RE = /(https?:\/\/[^\s<>]+)/;

function inlineNodes(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Adjacent plain-text pieces are merged so "link." + " more" stays one node.
  const pushText = (text: string) => {
    const last = nodes.at(-1);
    if (last && last.type === "text" && !last.marks) last.text = `${last.text as string}${text}`;
    else nodes.push({ type: "text", text });
  };
  for (const part of line.split(URL_RE)) {
    if (!part) continue;
    if (!part.startsWith("http")) {
      pushText(part);
      continue;
    }
    // Trailing sentence punctuation belongs to the prose, not the link.
    const trailing = /[.,;:)]+$/.exec(part)?.[0] ?? "";
    const href = part.slice(0, part.length - trailing.length);
    nodes.push({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] });
    if (trailing) pushText(trailing);
  }
  return nodes;
}

/**
 * Plain text → Atlassian Document Format. Blank lines separate paragraphs,
 * single newlines become hard breaks, a line of `---` becomes a rule, and URLs
 * become links. Jira ignores raw newlines inside a text node, which is why the
 * previous one-paragraph version rendered as a single blob.
 */
export function adf(text: string): AdfDoc {
  const content: AdfNode[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    if (lines.length === 1 && lines[0] === "---") {
      content.push({ type: "rule" });
      continue;
    }
    const inline: AdfNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      inline.push(...inlineNodes(line));
    });
    content.push({ type: "paragraph", content: inline });
  }
  if (content.length === 0) content.push({ type: "paragraph", content: [{ type: "text", text: "(no text)" }] });
  return { type: "doc", version: 1, content };
}
