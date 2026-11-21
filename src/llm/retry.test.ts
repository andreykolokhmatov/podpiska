import { APICallError, RetryError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyRateLimit,
  LlmQuotaExhaustedError,
  MAX_RATE_LIMIT_RETRIES,
  withRateLimitRetry,
} from './retry';

const URL = 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent';

/** The body Gemini returns with HTTP 429 (google.rpc.Status with QuotaFailure + RetryInfo). */
const googleBody = (quotaId: string, retryDelay?: string) =>
  JSON.stringify({
    error: {
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details. Please retry in 7.2s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId,
              quotaDimensions: { location: 'global', model: 'gemini-3.5-flash-lite' },
              quotaValue: '15',
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
        ...(retryDelay === undefined
          ? []
          : [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]),
      ],
    },
  });

const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';

const apiError = (
  statusCode: number,
  options: { body?: string; headers?: Record<string, string>; message?: string } = {},
) =>
  new APICallError({
    message: options.message ?? 'Resource has been exhausted',
    url: URL,
    requestBodyValues: {},
    statusCode,
    ...(options.headers === undefined ? {} : { responseHeaders: options.headers }),
    ...(options.body === undefined ? {} : { responseBody: options.body }),
    isRetryable: false,
  });

/** Fails with `errors` in order, then resolves 'ok'. */
const failing = (...errors: Error[]) => {
  let call = 0;
  return vi.fn(async () => {
    const error = errors[call];
    call += 1;
    if (error !== undefined) throw error;
    return 'ok';
  });
};

const noJitter = { random: () => 0 };

describe('classifyRateLimit', () => {
  it('reads RetryInfo.retryDelay for a per-minute quota', () => {
    expect(classifyRateLimit(apiError(429, { body: googleBody(PER_MINUTE, '7s') }))).toEqual({
      kind: 'rate',
      delayMs: 7000,
    });
  });

  it('treats a per-day QuotaFailure as daily even with a RetryInfo', () => {
    expect(classifyRateLimit(apiError(429, { body: googleBody(PER_DAY, '20s') }))).toEqual({
      kind: 'daily',
    });
  });

  it('falls back to the "retry in Ns" hint of the message', () => {
    const error = apiError(429, { body: googleBody(PER_MINUTE) });
    expect(classifyRateLimit(error)).toEqual({ kind: 'rate', delayMs: 7200 });
  });

  it('looks inside the SDK RetryError', () => {
    const inner = apiError(429, { body: googleBody(PER_DAY) });
    const wrapped = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [inner, inner, inner],
    });
    expect(classifyRateLimit(wrapped)).toEqual({ kind: 'daily' });
  });

  it('ignores non-429 errors', () => {
    expect(classifyRateLimit(apiError(500))).toBeUndefined();
    expect(classifyRateLimit(new Error('boom'))).toBeUndefined();
  });
});

describe('withRateLimitRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits retryDelay '7s' and retries", async () => {
    const call = failing(apiError(429, { body: googleBody(PER_MINUTE, '7s') }));
    const result = withRateLimitRetry(call, noJitter);

    await vi.advanceTimersByTimeAsync(6_999);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('adds at most 1s of jitter', async () => {
    const call = failing(apiError(429, { body: googleBody(PER_MINUTE, '7s') }));
    const result = withRateLimitRetry(call, { random: () => 0.999 });
    await vi.advanceTimersByTimeAsync(7_998);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
  });

  it('honours the Retry-After header', async () => {
    const call = failing(apiError(429, { headers: { 'retry-after': '3' } }));
    const result = withRateLimitRetry(call, noJitter);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
  });

  it('backs off exponentially without any delay info', async () => {
    const call = failing(apiError(429), apiError(429));
    const result = withRateLimitRetry(call, noJitter);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('caps a long retryDelay at 60s', async () => {
    const call = failing(apiError(429, { body: googleBody(PER_MINUTE, '300s') }));
    const result = withRateLimitRetry(call, noJitter);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe('ok');
  });

  it('gives up after the max retries with the last 429', async () => {
    const errors = Array.from({ length: MAX_RATE_LIMIT_RETRIES + 1 }, () =>
      apiError(429, { body: googleBody(PER_MINUTE, '1s') }),
    );
    const call = failing(...errors);
    const result = withRateLimitRetry(call, noJitter).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(errors[MAX_RATE_LIMIT_RETRIES]);
    expect(call).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
  });

  it('throws at once when the wait would pass the deadline', async () => {
    const error = apiError(429, { body: googleBody(PER_MINUTE, '7s') });
    const call = failing(error);
    const deadline = new Date(Date.now() + 5_000);
    await expect(withRateLimitRetry(call, { ...noJitter, deadline })).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits when the deadline leaves room', async () => {
    const call = failing(apiError(429, { body: googleBody(PER_MINUTE, '7s') }));
    const deadline = new Date(Date.now() + 8_000);
    const result = withRateLimitRetry(call, { ...noJitter, deadline });
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(result).resolves.toBe('ok');
  });

  it('keeps room for the retried call (minAttemptMs) before the deadline', async () => {
    const error = apiError(429, { body: googleBody(PER_MINUTE, '7s') });
    const call = failing(error);
    const deadline = new Date(Date.now() + 20_000);
    await expect(
      withRateLimitRetry(call, { ...noJitter, deadline, minAttemptMs: 15_000 }),
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rethrows a RetryError mixing a 500 and a 429 unchanged (SDK retries already spent)', async () => {
    const wrapped = new RetryError({
      message: "Failed after 2 attempts with non-retryable error: 'quota'",
      reason: 'errorNotRetryable',
      errors: [apiError(500), apiError(429, { body: googleBody(PER_MINUTE, '1s') })],
    });
    const call = failing(wrapped);
    await expect(withRateLimitRetry(call, noJitter)).rejects.toBe(wrapped);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a RetryError made only of 429s', async () => {
    const only429 = apiError(429, { body: googleBody(PER_MINUTE, '1s') });
    const call = failing(
      new RetryError({ message: 'x', reason: 'maxRetriesExceeded', errors: [only429, only429] }),
    );
    const result = withRateLimitRetry(call, noJitter);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('throws LlmQuotaExhaustedError on a daily quota without retrying', async () => {
    const call = failing(apiError(429, { body: googleBody(PER_DAY, '20s') }));
    const error = await withRateLimitRetry(call).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmQuotaExhaustedError);
    expect((error as Error).message).toMatch(/^llm_quota:/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a 500 untouched', async () => {
    const error = apiError(500);
    const call = failing(error);
    await expect(withRateLimitRetry(call)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
