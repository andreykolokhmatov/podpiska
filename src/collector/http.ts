import {
  ChannelUnavailableError,
  CollectorHttpError,
  DeadlineExceededError,
  RateLimitedError,
} from './errors';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export interface PoliteFetchOptions {
  fetchImpl?: FetchImpl;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
  limiter?: HostLimiter;
  timeoutMs?: number;
  /** Retries after the first attempt (network errors, timeouts, 5xx, 429). Default 2. */
  retries?: number;
  /**
   * Epoch ms (on `now`): no attempt starts at or after it, checked after waiting for the limiter
   * and any backoff. DeadlineExceededError when nothing was sent, else the last attempt's error.
   */
  deadline?: number;
}

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/142.0.0.0 Safari/537.36';

const RETRY_BACKOFF_MS = [1000, 3000] as const;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serializes request start times so that any two requests to the host are at least
 * `minGapMs` (+ jitter) apart, no matter how many workers share it.
 */
export class HostLimiter {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minGapMs = 1000,
    private readonly jitterMs = 250,
  ) {}

  acquire(sleep: Sleep, now: () => number, random: () => number): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.nextAt - now();
      if (wait > 0) {
        await sleep(wait);
      }
      this.nextAt = now() + this.minGapMs + Math.floor(random() * this.jitterMs);
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

const sharedLimiter = new HostLimiter();

/** Parses `Retry-After` as seconds or an HTTP-date; returns ms or null. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function isChannelPreviewUrl(location: string, base: string): boolean {
  try {
    return new URL(location, base).pathname.startsWith('/s/');
  } catch {
    return false;
  }
}

/**
 * GET with a browser UA, a shared host rate limit, a timeout and bounded retries
 * (network errors, timeouts, 5xx, 429). Returns the HTML body of a 200 response.
 */
export async function politeFetch(url: string, options: PoliteFetchOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const limiter = options.limiter ?? sharedLimiter;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(
    0,
    Math.min(options.retries ?? RETRY_BACKOFF_MS.length, RETRY_BACKOFF_MS.length),
  );

  let lastError: unknown = null;
  let retryAfterMs: number | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 0;
      await sleep(retryAfterMs ?? backoff + Math.floor(random() * 500));
      retryAfterMs = null;
    }
    await limiter.acquire(sleep, now, random);
    if (options.deadline !== undefined && now() >= options.deadline) {
      // After a failed attempt its error is the real outcome; before any, nothing was sent.
      throw lastError ?? new DeadlineExceededError(`deadline passed before requesting ${url}`);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'ru,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (error) {
      lastError = new CollectorHttpError(null, `request to ${url} failed`, { cause: error });
      continue;
    }

    const { status } = response;
    if (status === 200) {
      return response.text();
    }
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location') ?? '';
      if (!isChannelPreviewUrl(location, url)) {
        throw new ChannelUnavailableError(
          'not_found_or_preview_disabled',
          'channel not found or its web preview is disabled',
        );
      }
      throw new CollectorHttpError(status, `unexpected redirect from ${url}`);
    }
    if (status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now());
      if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
        throw new RateLimitedError(
          `t.me asked to retry after ${Math.ceil(retryAfter / 1000)}s`,
          retryAfter,
        );
      }
      lastError = new RateLimitedError('t.me rate limited the request', retryAfter);
      retryAfterMs = retryAfter;
      continue;
    }
    if (status >= 500) {
      lastError = new CollectorHttpError(status, `t.me responded ${status}`);
      continue;
    }
    throw new CollectorHttpError(status, `t.me responded ${status}`);
  }
  throw lastError ?? new CollectorHttpError(null, `request to ${url} failed`);
}
