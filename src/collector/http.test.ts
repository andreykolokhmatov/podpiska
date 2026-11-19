import { describe, expect, it, vi } from 'vitest';

import {
  ChannelUnavailableError,
  CollectorHttpError,
  DeadlineExceededError,
  RateLimitedError,
} from './errors';
import { type FetchImpl, HostLimiter, parseRetryAfter, politeFetch, USER_AGENT } from './http';

const URL_S = 'https://t.me/s/toporlive';

function setup(responses: Array<() => Response>) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  });
  const calls: Array<{ url: string; init: RequestInit; at: number }> = [];
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    calls.push({ url, init, at: clock });
    const next = responses[calls.length - 1];
    if (!next) {
      throw new Error('no more responses');
    }
    return next();
  });
  const options = {
    fetchImpl,
    sleep,
    now: () => clock,
    random: () => 0,
    limiter: new HostLimiter(1000, 0),
  };
  return { options, calls, sleeps };
}

const ok = () => new Response('<html>ok</html>', { status: 200 });
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(null, { status: code, headers });

describe('politeFetch', () => {
  it('returns the body and sends browser-like headers', async () => {
    const { options, calls } = setup([ok]);
    await expect(politeFetch(URL_S, options)).resolves.toBe('<html>ok</html>');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(USER_AGENT);
    expect(headers['Accept-Language']).toMatch(/^ru,en/);
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours a short Retry-After on 429', async () => {
    const { options, calls, sleeps } = setup([status(429, { 'Retry-After': '2' }), ok]);
    await expect(politeFetch(URL_S, options)).resolves.toBe('<html>ok</html>');
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(2000);
  });

  it('gives up with RateLimitedError when Retry-After is too long', async () => {
    const { options, calls } = setup([status(429, { 'Retry-After': '120' })]);
    await expect(politeFetch(URL_S, options)).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(1);
  });

  it('retries 5xx and succeeds on the third attempt', async () => {
    const { options, calls } = setup([status(503), status(503), ok]);
    await expect(politeFetch(URL_S, options)).resolves.toBe('<html>ok</html>');
    expect(calls).toHaveLength(3);
  });

  it('fails with CollectorHttpError after three 5xx', async () => {
    const { options, calls } = setup([status(503), status(503), status(503)]);
    const error = await politeFetch(URL_S, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CollectorHttpError);
    expect((error as CollectorHttpError).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('with retries 0 fails on the first 429 or 5xx', async () => {
    const limited = setup([status(429, { 'Retry-After': '2' }), ok]);
    await expect(politeFetch(URL_S, { ...limited.options, retries: 0 })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(limited.calls).toHaveLength(1);
    expect(limited.sleeps).not.toContain(2000);

    const down = setup([status(503), ok]);
    await expect(politeFetch(URL_S, { ...down.options, retries: 0 })).rejects.toBeInstanceOf(
      CollectorHttpError,
    );
    expect(down.calls).toHaveLength(1);
  });

  it('retries network errors', async () => {
    const { options, calls } = setup([
      () => {
        throw new TypeError('fetch failed');
      },
      ok,
    ]);
    await expect(politeFetch(URL_S, options)).resolves.toBe('<html>ok</html>');
    expect(calls).toHaveLength(2);
  });

  it('does not retry other 4xx', async () => {
    const { options, calls } = setup([status(404), ok]);
    await expect(politeFetch(URL_S, options)).rejects.toBeInstanceOf(CollectorHttpError);
    expect(calls).toHaveLength(1);
  });

  it('treats a redirect away from /s/ as an unavailable channel', async () => {
    const { options, calls } = setup([status(302, { Location: '/x' })]);
    await expect(politeFetch(URL_S, options)).rejects.toBeInstanceOf(ChannelUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it('never starts a request once the limiter wait ran past the deadline', async () => {
    const { options, calls } = setup([ok, ok]);
    const deadline = 1_000_000 + 500;
    await expect(politeFetch(URL_S, { ...options, deadline })).resolves.toBe('<html>ok</html>');
    // The limiter now holds the next start until 1_001_000, past the deadline.
    await expect(politeFetch(URL_S, { ...options, deadline })).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    expect(calls).toHaveLength(1);
  });

  it('after a failed attempt reports that failure when the deadline stops the retry', async () => {
    const { options, calls } = setup([status(503), ok]);
    const error = await politeFetch(URL_S, { ...options, deadline: 1_000_000 + 500 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CollectorHttpError);
    expect((error as CollectorHttpError).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('keeps a minimum gap between requests through the shared limiter', async () => {
    const { options, calls } = setup([ok, ok, ok]);
    await Promise.all([
      politeFetch(URL_S, options),
      politeFetch(URL_S, options),
      politeFetch(URL_S, options),
    ]);
    const times = calls.map((call) => call.at);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1000);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-15T10:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Sun, 15 Nov 2026 10:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});
