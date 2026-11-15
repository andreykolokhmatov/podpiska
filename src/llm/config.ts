import type { LlmEnv } from '@/lib/env';

/**
 * Everything needed to reach the LLM. Passed as a parameter (never read from env inside the
 * pipeline) so a per-user key (BYOK) can be plugged in later. Contains a secret: never log it.
 */
export interface LlmConfig {
  provider: 'google';
  apiKey: string;
  /** Gemini-compatible proxy prefix, e.g. https://api.proxyapi.ru/google/v1beta. */
  baseURL?: string;
  models: { fast: string; smart: string };
}

export function llmConfigFromEnv(env: LlmEnv): LlmConfig {
  if (env.GOOGLE_GENERATIVE_AI_API_KEY === undefined) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is required when LLM_PROVIDER=google');
  }
  return {
    provider: env.LLM_PROVIDER,
    apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    ...(env.LLM_BASE_URL === undefined ? {} : { baseURL: env.LLM_BASE_URL }),
    models: { fast: env.LLM_MODEL_FAST, smart: env.LLM_MODEL_SMART },
  };
}
