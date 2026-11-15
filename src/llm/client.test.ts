import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { createLlm } from './client';
import { llmConfigFromEnv } from './config';

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
        LLM_BASE_URL: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      }),
    ).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
    vi.unstubAllEnvs();
  });
});
