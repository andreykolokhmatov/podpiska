import { APICallError, generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLlm } from './client';
import { llmConfigFromEnv } from './config';
import { LlmQuotaExhaustedError, withRateLimitRetry } from './retry';

const geminiResponse = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
};

describe('createLlm', () => {
  it('sends requests to <baseURL>/models/<id>:generateContent with x-goog-api-key', async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(geminiResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const config = llmConfigFromEnv({
      LLM_PROVIDER: 'google',
      LLM_MODEL_FAST: 'gemini-fast',
      LLM_MODEL_SMART: 'gemini-smart',
      LLM_CONCURRENCY: 3,
      LLM_BASE_URL: 'https://proxy.example/google/v1beta',
      GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
    });
    const llm = createLlm(config, { fetch: fetchSpy });

    const result = await generateText({
      model: llm.fast.model,
      providerOptions: llm.fast.providerOptions,
      prompt: 'hi',
    });

    expect(result.text).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://proxy.example/google/v1beta/models/gemini-fast:generateContent',
    );
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
    const body = JSON.parse(String(init?.body)) as {
      generationConfig?: { thinkingConfig?: Record<string, unknown> };
    };
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(llm.smart.id).toBe('gemini-smart');
    expect(llm.fast.maxOutputTokens).toBe(8_000);
    expect(llm.smart.maxOutputTokens).toBe(12_000);
  });

  it('never falls back to the env key', () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'env-key');
    expect(() =>
      llmConfigFromEnv({
        LLM_PROVIDER: 'google',
        LLM_MODEL_FAST: 'a',
        LLM_MODEL_SMART: 'b',
        LLM_CONCURRENCY: 3,
        LLM_BASE_URL: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      }),
    ).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
    vi.unstubAllEnvs();
  });

  it('passes LLM_CONCURRENCY through as llm.concurrency', () => {
    const llm = createLlm(
      llmConfigFromEnv({
        LLM_PROVIDER: 'google',
        LLM_MODEL_FAST: 'a',
        LLM_MODEL_SMART: 'b',
        LLM_CONCURRENCY: 1,
        LLM_BASE_URL: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: 'k',
      }),
    );
    expect(llm.concurrency).toBe(1);
  });
});

describe('createLlm 429 ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const config = llmConfigFromEnv({
    LLM_PROVIDER: 'google',
    LLM_MODEL_FAST: 'gemini-fast',
    LLM_MODEL_SMART: 'gemini-smart',
    LLM_CONCURRENCY: 3,
    LLM_BASE_URL: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
  });
  const rateLimited = (quotaId: string) =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: 'You exceeded your current quota.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId }],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
          ],
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  const ok = () =>
    new Response(JSON.stringify(geminiResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('the SDK does not retry a 429 itself (maxRetries applies to other errors only)', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => rateLimited('PerMinute'));
    const llm = createLlm(config, { fetch: fetchSpy });
    const error = await generateText({ model: llm.fast.model, prompt: 'hi', maxRetries: 2 }).catch(
      (caught: unknown) => caught,
    );
    expect(APICallError.isInstance(error) && error.statusCode).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('withRateLimitRetry waits the Google retryDelay and gets through', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'))
      .mockResolvedValue(ok());
    const llm = createLlm(config, { fetch: fetchSpy });
    const result = withRateLimitRetry(
      () => generateText({ model: llm.fast.model, prompt: 'hi', maxRetries: 2 }),
      { random: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect((await result).text).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('the SDK still retries a 500 with its own maxRetries', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response('{"error":{"code":500,"message":"x","status":"INTERNAL"}}', { status: 500 }),
    );
    const llm = createLlm(config, { fetch: fetchSpy });
    const result = withRateLimitRetry(() =>
      generateText({ model: llm.fast.model, prompt: 'hi', maxRetries: 2 }),
    ).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(Error);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('a daily quota fails after one request', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      rateLimited('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
    );
    const llm = createLlm(config, { fetch: fetchSpy });
    await expect(
      withRateLimitRetry(() => generateText({ model: llm.fast.model, prompt: 'hi' })),
    ).rejects.toBeInstanceOf(LlmQuotaExhaustedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
