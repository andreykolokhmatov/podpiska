import 'dotenv/config';

import { generateText, Output } from 'ai';
import { z } from 'zod';

import { getLlmEnv } from '@/lib/env';

import { createLlm, type LlmStage } from './client';
import { llmConfigFromEnv } from './config';

// Manual check (costs a few tokens): structured output through the configured base URL.
const schema = z.object({
  city: z.string(),
  population: z.number().int(),
  kind: z.enum(['city', 'town', 'village']),
  nickname: z.string().nullable(),
});

async function check(name: string, stage: LlmStage): Promise<boolean> {
  const started = Date.now();
  try {
    const result = await generateText({
      model: stage.model,
      providerOptions: stage.providerOptions,
      ...(stage.maxOutputTokens === undefined ? {} : { maxOutputTokens: stage.maxOutputTokens }),
      system: 'Answer with facts only.',
      prompt: 'Describe the city of Omsk, Russia.',
      output: Output.object({ schema }),
      maxRetries: 1,
      timeout: 60_000,
    });
    const { inputTokens, outputTokens } = result.usage;
    console.log(
      `${name} ${stage.id}: ok in ${Date.now() - started}ms, tokens in ${inputTokens ?? '?'} out ${outputTokens ?? '?'} ->`,
      JSON.stringify(result.output),
    );
    return true;
  } catch (error) {
    console.log(`${name} ${stage.id}: error ${error instanceof Error ? error.message : 'unknown'}`);
    return false;
  }
}

async function main(): Promise<number> {
  const config = llmConfigFromEnv(getLlmEnv());
  console.log(`base URL: ${config.baseURL ?? '(provider default)'}`);
  const llm = createLlm(config);
  const results = [await check('fast', llm.fast), await check('smart', llm.smart)];
  return results.every(Boolean) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  },
);
