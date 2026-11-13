/**
 * Classified integration failures. The sync runner uses `kind` to decide
 * whether to retry, mark a connection for re-authorization, or mark an
 * account as disconnected.
 */
export type IntegrationErrorKind =
  | "AUTH_REVOKED" // refresh token revoked/expired → user must reconnect
  | "PERMISSION_DENIED" // login no longer has access to this account
  | "NOT_APPROVED" // e.g. Google Ads developer token not approved for production accounts
  | "APP_BLOCKED" // the platform blocked our app or developer account (e.g. Meta "#200 API access blocked"): every account fails, none lost access
  | "NOT_CONFIGURED" // server is missing credentials
  | "RATE_LIMITED" // retry later
  | "TRANSIENT" // network / 5xx — retry
  | "INVALID_REQUEST"; // bug or bad query — do not retry

export class IntegrationError extends Error {
  constructor(
    public kind: IntegrationErrorKind,
    message: string,
    public retryAfterMs?: number,
    public status?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }

  get retryable(): boolean {
    return this.kind === "RATE_LIMITED" || this.kind === "TRANSIENT";
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries retryable IntegrationErrors with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof IntegrationError ? e : new IntegrationError("TRANSIENT", (e as Error).message);
      if (!err.retryable || i >= attempts) throw err;
      const backoff = Math.min(max, base * 2 ** (i - 1)) * (0.8 + Math.random() * 0.4);
      await sleep(Math.max(backoff, err.retryAfterMs ?? 0));
    }
  }
}
