import { ChannelUnavailableError, CollectorError } from './errors';
import { normalizeChannel } from './normalize';
import type { ChannelStore } from './store';
import type { PostSource } from './types';

export type CollectResult =
  | { username: string; ok: true; collected: number; inserted: number }
  | { username: string; ok: false; code: string; message: string };

export interface CollectDeps {
  source: PostSource;
  store: ChannelStore;
  concurrency?: number;
}

function toFailure(username: string, error: unknown): CollectResult {
  if (error instanceof CollectorError) {
    return { username, ok: false, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { username, ok: false, code: 'Unexpected', message };
}

/** Collects every channel independently; never throws, one result per input. */
export async function collectForChannels(
  inputs: readonly string[],
  since: Date,
  { source, store, concurrency = 4 }: CollectDeps,
): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  const queue: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    try {
      const username = normalizeChannel(input);
      if (!seen.has(username)) {
        seen.add(username);
        queue.push(username);
      }
    } catch (error) {
      results.push(toFailure(input.trim(), error));
    }
  }

  const collected = new Map<string, CollectResult>();
  const collectOne = async (username: string): Promise<CollectResult> => {
    try {
      const { info, posts } = await source.fetchChannel(username, since);
      const saved = await store.saveChannelPosts(info, posts);
      return { username, ok: true, ...saved };
    } catch (error) {
      if (error instanceof ChannelUnavailableError) {
        try {
          await store.markChannelUnavailable(username);
        } catch (markError) {
          return toFailure(username, markError);
        }
      }
      return toFailure(username, error);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const username = queue[next];
      next += 1;
      if (username !== undefined) {
        collected.set(username, await collectOne(username));
      }
    }
  };
  const workers = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  for (const username of queue) {
    const result = collected.get(username);
    if (result) {
      results.push(result);
    }
  }
  return results;
}
