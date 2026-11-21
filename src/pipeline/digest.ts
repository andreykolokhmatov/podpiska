import { createHash } from 'node:crypto';

import { generateText, Output } from 'ai';

import type { LlmStage } from '@/llm/client';
import { withRateLimitRetry, type RateLimitRetryOptions } from '@/llm/retry';
import { addUsage, emptyUsage, fromModelUsage, type TokenUsage } from '@/llm/usage';

import { mskDayRange } from './day';
import {
  digestLlmSchema,
  storedDigestSchema,
  type DigestItem,
  type StoredDigest,
} from './digest-schema';
import { buildDigestPrompt, DIGEST_PROMPT_VERSION, DIGEST_SYSTEM_PROMPT } from './prompts';
import type { DayPost, DigestStore } from './store';

const MAX_BATCH_POSTS = 40;
const MAX_BATCH_CHARS = 40_000;
const MAX_TITLE = 200;
const MAX_SUMMARY = 800;
const MAX_TOPICS = 5;
const DIGEST_TIMEOUT_MS = 120_000;

export interface DigestDeps {
  store: DigestStore;
  fast: LlmStage;
  /** 429 waits never end past `retry.deadline`. */
  retry?: RateLimitRetryOptions | undefined;
}

export interface DigestChannel {
  id: number;
  username: string;
  title: string | null;
}

export interface DigestOutcome {
  status: 'cached' | 'generated' | 'empty';
  digest: StoredDigest;
  usage: TokenUsage;
}

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

export function digestInputHash(modelId: string, posts: readonly DayPost[]): string {
  const lines = [...posts]
    .sort((a, b) => a.tgPostId - b.tgPostId)
    .map((post) => `${post.tgPostId}:${sha1(post.text)}`);
  return createHash('sha256')
    .update([DIGEST_PROMPT_VERSION, modelId, ...lines].join('\n'))
    .digest('hex');
}

/** Splits posts into LLM calls bounded by post count and total characters. */
export function batchPosts(posts: readonly DayPost[]): DayPost[][] {
  const batches: DayPost[][] = [];
  let current: DayPost[] = [];
  let chars = 0;
  for (const post of posts) {
    const size = Math.min(post.text.length, 1_600);
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_POSTS || chars + size > MAX_BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(post);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

async function digestBatch(
  { fast, retry }: Pick<DigestDeps, 'fast' | 'retry'>,
  channel: DigestChannel,
  day: string,
  batch: readonly DayPost[],
): Promise<{ items: DigestItem[]; usage: TokenUsage }> {
  const call = () =>
    generateText({
      model: fast.model,
      providerOptions: fast.providerOptions,
      ...(fast.maxOutputTokens === undefined ? {} : { maxOutputTokens: fast.maxOutputTokens }),
      system: DIGEST_SYSTEM_PROMPT,
      prompt: buildDigestPrompt(channel, day, batch),
      output: Output.object({ schema: digestLlmSchema }),
      maxRetries: 2,
      timeout: DIGEST_TIMEOUT_MS,
    });
  const result = await withRateLimitRetry(call, retry);

  // The model may only cite posts of this batch; anything else is dropped.
  const idByTg = new Map(batch.map((post) => [post.tgPostId, post.id]));
  const items: DigestItem[] = [];
  for (const item of result.output.items) {
    const postIds = [...new Set(item.postIds.flatMap((tgId) => idByTg.get(tgId) ?? []))];
    const title = item.title.trim().slice(0, MAX_TITLE);
    const summary = item.summary.trim().slice(0, MAX_SUMMARY);
    if (postIds.length === 0 || (title === '' && summary === '')) continue;
    items.push({
      title,
      summary,
      importance: clamp(item.importance, 1, 5),
      topics: item.topics
        .map((topic) => topic.trim())
        .filter(Boolean)
        .slice(0, MAX_TOPICS),
      postIds,
    });
  }
  return { items, usage: fromModelUsage(result.usage) };
}

const EMPTY: StoredDigest = { version: 1, items: [] };

/**
 * One digest per (channel, MSK day). A cached digest computed at/after the day's end is
 * final; otherwise it is recomputed only when the input hash (prompt version, model, post
 * texts) changes.
 * `watermark` is a time by which every post of the channel was collected (the caller's
 * collect start or earlier). With `complete: false` (collect failed or started mid-day) the
 * digest is saved non-final: its computedAt stays before the day end.
 * Saved only if every batch succeeded; any failure throws and nothing is cached.
 */
export async function summarizeChannelDay(
  { store, fast, retry }: DigestDeps,
  channel: DigestChannel,
  day: string,
  watermark: Date,
  options: { force?: boolean; complete?: boolean } = {},
): Promise<DigestOutcome> {
  const range = mskDayRange(day);
  const cachedRow = options.force === true ? undefined : await store.getDigest(channel.id, day);
  const cached = cachedRow && storedDigestSchema.safeParse(cachedRow.summary);
  if (cachedRow && cached?.success && cachedRow.computedAt.getTime() >= range.end.getTime()) {
    return { status: 'cached', digest: cached.data, usage: emptyUsage() };
  }

  const posts = await store.getChannelDayPosts(channel.id, range);
  if (posts.length === 0) {
    return { status: 'empty', digest: EMPTY, usage: emptyUsage() };
  }
  const inputHash = digestInputHash(fast.id, posts);
  if (cachedRow && cached?.success && cachedRow.inputHash === inputHash) {
    return { status: 'cached', digest: cached.data, usage: emptyUsage() };
  }

  let usage = emptyUsage();
  const items: DigestItem[] = [];
  for (const batch of batchPosts(posts)) {
    const result = await digestBatch({ fast, retry }, channel, day, batch);
    items.push(...result.items);
    usage = addUsage(usage, result.usage);
  }

  const digest: StoredDigest = { version: 1, items };
  await store.saveDigest({
    channelId: channel.id,
    day,
    summary: digest,
    model: fast.id,
    inputHash,
    computedAt:
      options.complete === false
        ? new Date(Math.min(watermark.getTime(), range.end.getTime() - 1))
        : watermark,
  });
  return { status: 'generated', digest, usage };
}
