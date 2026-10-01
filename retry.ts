// Shared retry policy for Slack and Jira calls. Only transport-level failures
// (429, 5xx, dropped connections) are retried; a 4xx from either API means the
// request itself is wrong and repeating it would not help.

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export type RetryOptions = {
  label: string;
  attempts?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  // Node's fetch reports dropped connections and DNS failures as TypeError("fetch failed").
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= attempts) throw err;
      const hinted = err instanceof RetryableError ? err.retryAfterMs : undefined;
      const waitMs = Math.min(hinted ?? 1000 * 2 ** (attempt - 1), 30_000);
      opts.log?.(
        `[retry] ${opts.label}: ${(err as Error).message}; retrying in ${waitMs} ms (${attempt}/${attempts})`,
      );
      await sleep(waitMs);
    }
  }
}
