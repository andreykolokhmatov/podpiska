import { createGoogleGenerativeAI, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { wrapLanguageModel, type generateText, type LanguageModel } from 'ai';

import type { LlmConfig } from './config';
import { rateLimitMiddleware } from './retry';

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

/** A model plus the call settings every caller of that stage must use. */
export interface LlmStage {
  model: LanguageModel;
  id: string;
  providerOptions: ProviderOptions;
  maxOutputTokens?: number;
}

export interface Llm {
  fast: LlmStage;
  smart: LlmStage;
  /** Max digest calls in flight (LLM_CONCURRENCY); the pipeline defaults it when absent. */
  concurrency?: number;
}

// thinkingBudget: 0 is rejected (HTTP 400) by gemini-3.5-flash-lite behind ProxyAPI;
// a thinking level keeps latency and cost low on every Gemini 3+ model.
const fastOptions: GoogleLanguageModelOptions = { thinkingConfig: { thinkingLevel: 'low' } };
const smartOptions: GoogleLanguageModelOptions = { thinkingConfig: { thinkingLevel: 'low' } };

// Gemini counts thinking tokens against maxOutputTokens. ProxyAPI reserves balance for the
// full max up front, so both stages set an explicit cap no larger than needed:
// a channel-day digest is ~1-3k tokens, a whole issue ~6-10k.
const FAST_MAX_OUTPUT_TOKENS = 8_000;
const SMART_MAX_OUTPUT_TOKENS = 12_000;

export interface CreateLlmOptions {
  /** Test seam: replaces the HTTP client. */
  fetch?: typeof fetch;
}

export function createLlm(config: LlmConfig, options: CreateLlmOptions = {}): Llm {
  const google = createGoogleGenerativeAI({
    // Always explicit: the provider must never fall back to process.env.
    apiKey: config.apiKey,
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // 429 is retried by withRateLimitRetry only (see retry.ts), never by the SDK as well.
  const model = (id: string): LanguageModel =>
    wrapLanguageModel({ model: google(id), middleware: rateLimitMiddleware });
  return {
    ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    fast: {
      model: model(config.models.fast),
      id: config.models.fast,
      providerOptions: { google: fastOptions },
      maxOutputTokens: FAST_MAX_OUTPUT_TOKENS,
    },
    smart: {
      model: model(config.models.smart),
      id: config.models.smart,
      providerOptions: { google: smartOptions },
      maxOutputTokens: SMART_MAX_OUTPUT_TOKENS,
    },
  };
}
