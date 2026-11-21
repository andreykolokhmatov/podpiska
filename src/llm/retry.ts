import { APICallError, RetryError, type LanguageModelMiddleware } from 'ai';
import { z } from 'zod';

/**
 * 429 handling is owned here, not by the AI SDK.
 *
 * The SDK retries every `isRetryable` APICallError (429 included) `maxRetries` times with a
 * 2s/4s backoff and only reads the Retry-After header, never Google's RetryInfo body. Wrapping
 * generateText in our own 429 loop on top of that would multiply attempts (3 × 5 calls) and
 * burn a free-tier RPM budget. So `rateLimitMiddleware` (applied to every model in createLlm)
 * marks 429 as non-retryable for the SDK, and `withRateLimitRetry` around the call decides:
 * per-minute limit → wait the server's delay and retry; per-day quota → fail at once.
 * Every other error keeps the SDK's own maxRetries behaviour.
 */

/** The provider's daily quota is spent: retrying before it resets only wastes the build. */
export class LlmQuotaExhaustedError extends Error {
  override readonly name = 'LlmQuotaExhaustedError';
  readonly code = 'llm_quota';
  constructor(message = 'llm_quota: the LLM daily quota is exhausted') {
    super(message);
  }
}

export const MAX_RATE_LIMIT_RETRIES = 4;
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const MAX_JITTER_MS = 1_000;

export type RateLimit = { kind: 'daily' } | { kind: 'rate'; delayMs: number | undefined };

const googleErrorBody = z.object({
  error: z.object({
    message: z.string().optional(),
    details: z.array(z.unknown()).nullish(),
  }),
});

const quotaFailure = z.object({
  '@type': z.string().endsWith('google.rpc.QuotaFailure'),
  violations: z
    .array(
      z.object({
        quotaId: z.string().optional(),
        quotaMetric: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

const retryInfo = z.object({
  '@type': z.string().endsWith('google.rpc.RetryInfo'),
  retryDelay: z.string(),
});

const PER_DAY = /per\s*day|daily/i;

/** Google durations are "<seconds>s", e.g. "7s" or "0.5s". */
function durationMs(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1000;
}

function headerDelayMs(
  headers: Record<string, string> | undefined,
  now: number,
): number | undefined {
  if (headers === undefined) return undefined;
  const ms = Number.parseFloat(headers['retry-after-ms'] ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const after = headers['retry-after'];
  if (after === undefined) return undefined;
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function parseBody(error: APICallError): z.infer<typeof googleErrorBody> | undefined {
  const fromData = googleErrorBody.safeParse(error.data);
  if (fromData.success) return fromData.data;
  if (error.responseBody === undefined) return undefined;
  try {
    const parsed = googleErrorBody.safeParse(JSON.parse(error.responseBody));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A non-JSON body (e.g. a proxy's HTML page) carries no quota details.
    return undefined;
  }
}

const is429 = (error: unknown): error is APICallError =>
  APICallError.isInstance(error) && error.statusCode === 429;

/** The 429 behind an error, if any (the SDK wraps errors after its own retries in RetryError). */
function rateLimitError(error: unknown): APICallError | undefined {
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  return is429(inner) ? inner : undefined;
}

/**
 * Only a pure 429 may be retried here. A RetryError mixing e.g. a 500 with a 429 already
 * spent the SDK's own retries; rerunning the call would run them all again.
 */
function retryable429(error: unknown): boolean {
  return RetryError.isInstance(error)
    ? error.errors.length > 0 && error.errors.every(is429)
    : is429(error);
}

/** undefined: not a 429. A daily quota wins over any RetryInfo in the same body. */
export function classifyRateLimit(error: unknown, now = Date.now()): RateLimit | undefined {
  const apiError = rateLimitError(error);
  if (apiError === undefined) return undefined;

  const body = parseBody(apiError);
  let delayMs: number | undefined;
  for (const detail of body?.error.details ?? []) {
    const failure = quotaFailure.safeParse(detail);
    if (failure.success) {
      const daily = (failure.data.violations ?? []).some((violation) =>
        [violation.quotaId, violation.quotaMetric, violation.description].some(
          (text) => text !== undefined && PER_DAY.test(text),
        ),
      );
      if (daily) return { kind: 'daily' };
    }
    const info = retryInfo.safeParse(detail);
    if (info.success) delayMs = durationMs(info.data.retryDelay);
  }
  const message = body?.error.message ?? apiError.message;
  if (PER_DAY.test(message)) return { kind: 'daily' };

  delayMs ??= headerDelayMs(apiError.responseHeaders, now);
  if (delayMs === undefined) {
    const hinted = /retry in (\d+(?:\.\d+)?)s/i.exec(message)?.[1];
    if (hinted !== undefined) delayMs = Number(hinted) * 1000;
  }
  return { kind: 'rate', delayMs };
}

export interface RateLimitRetryOptions {
  /** A wait that would end at or past this instant is not started: the 429 is thrown. */
  deadline?: Date | undefined;
  /**
   * Time a new attempt needs after the wait: a wait that leaves less than this before the
   * deadline is not started either (the retried call itself must fit).
   */
  minAttemptMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  onRetry?: (info: { attempt: number; waitMs: number }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `call`, retrying per-minute 429s within the deadline; a daily quota throws at once. */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxRetries = options.maxRetries ?? MAX_RATE_LIMIT_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const limit = classifyRateLimit(error, now().getTime());
      if (limit === undefined) throw error;
      if (limit.kind === 'daily') throw new LlmQuotaExhaustedError();
      if (attempt >= maxRetries || !retryable429(error)) throw error;

      const base = limit.delayMs ?? BACKOFF_BASE_MS * 2 ** attempt;
      const waitMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, base) + Math.round(random() * MAX_JITTER_MS);
      if (
        options.deadline !== undefined &&
        now().getTime() + waitMs + (options.minAttemptMs ?? 0) >= options.deadline.getTime()
      ) {
        throw error;
      }
      options.onRetry?.({ attempt: attempt + 1, waitMs });
      await sleep(waitMs);
    }
  }
}

/** Makes 429 non-retryable for the AI SDK so withRateLimitRetry alone owns it. */
export const rateLimitMiddleware: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate }) => {
    try {
      return await doGenerate();
    } catch (error) {
      if (!APICallError.isInstance(error) || error.statusCode !== 429 || !error.isRetryable) {
        throw error;
      }
      throw new APICallError({
        message: error.message,
        url: error.url,
        requestBodyValues: error.requestBodyValues,
        statusCode: error.statusCode,
        ...(error.responseHeaders === undefined ? {} : { responseHeaders: error.responseHeaders }),
        ...(error.responseBody === undefined ? {} : { responseBody: error.responseBody }),
        cause: error,
        isRetryable: false,
        data: error.data,
      });
    }
  },
};
