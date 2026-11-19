import {
  DeadlineExceededError,
  isLikelyBot,
  RateLimitedError,
  type ChannelInfo,
  type PostSource,
} from '@/collector';

import { toAddChannelError, type ChannelsStore } from './add';

/**
 * found: public channel, may be added · subscribed: the user already has it · bot: a bot name,
 * never scraped · invalid / private / not_found: cannot be added · retry_later: t.me failed for
 * this one (timeout, 5xx) · pending: not checked in this call (time budget, t.me rate limit or
 * only part of the batch fit the lookup quota), send it again.
 */
export type ResolveStatus =
  'found' | 'subscribed' | 'bot' | 'invalid' | 'private' | 'not_found' | 'retry_later' | 'pending';

export interface ResolvedChannel {
  username: string;
  status: ResolveStatus;
  /** found and subscribed (when known) only. */
  channel?: ChannelInfo;
}

export interface ResolveChannelsResult {
  /** One per input username, input order. */
  results: ResolvedChannel[];
  /** t.me asked to slow down: wait this long before sending the pending ones. */
  retryAfterMs: number | null;
}

export class LookupLimitError extends Error {
  override readonly name = 'LookupLimitError';

  constructor() {
    super('daily channel lookup limit reached');
  }
}

export interface ResolveDeps {
  store: Pick<ChannelsStore, 'findAvailableChannels' | 'listLinkedUsernames' | 'upsertChannel'>;
  source: Pick<PostSource, 'fetchChannelInfo'>;
  now: () => number;
}

export interface ResolveOptions {
  /** Epoch ms; no new t.me fetch starts at or after it. */
  deadline: number;
  /**
   * Takes up to `count` t.me lookups (cache misses) from the user's daily quota and returns how
   * many were granted (0..count); 0 → LookupLimitError. Called once, only when there is something
   * to fetch. Names beyond the granted count stay `pending`.
   */
  claimLookups: (count: number) => Promise<number>;
  /** Gives back granted lookups that were not spent; called once after a claim, even on a throw. */
  refundLookups: (count: number) => Promise<void>;
}

/** Used when t.me rate-limits without a Retry-After header. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;

/**
 * Checks normalized, unique usernames for a bulk add: links and the channel cache first (two
 * queries, no scrape), then t.me one by one for the unknown ones until the deadline.
 */
export async function resolveChannels(
  deps: ResolveDeps,
  userId: number,
  usernames: readonly string[],
  options: ResolveOptions,
): Promise<ResolveChannelsResult> {
  const lookupable = usernames.filter((username) => !isLikelyBot(username));
  const [linked, known] = await Promise.all([
    deps.store.listLinkedUsernames(userId, lookupable),
    deps.store.findAvailableChannels(lookupable),
  ]);
  const linkedSet = new Set(linked);
  const knownByName = new Map(known.map((channel) => [channel.username, channel]));

  const byName = new Map<string, ResolvedChannel>();
  const unknown: string[] = [];
  for (const username of usernames) {
    const channel = knownByName.get(username);
    if (isLikelyBot(username)) {
      byName.set(username, { username, status: 'bot' });
    } else if (linkedSet.has(username)) {
      byName.set(username, { username, status: 'subscribed', ...(channel ? { channel } : {}) });
    } else if (channel !== undefined) {
      byName.set(username, { username, status: 'found', channel });
    } else {
      unknown.push(username);
    }
  }

  let retryAfterMs: number | null = null;
  if (unknown.length > 0) {
    const granted = Math.min(
      Math.max(await options.claimLookups(unknown.length), 0),
      unknown.length,
    );
    if (granted === 0) throw new LookupLimitError();
    let spent = 0;
    try {
      for (const [index, username] of unknown.entries()) {
        if (index >= granted || retryAfterMs !== null || deps.now() >= options.deadline) {
          byName.set(username, { username, status: 'pending' });
          continue;
        }
        try {
          const channel = await deps.source.fetchChannelInfo(username, {
            deadline: options.deadline,
          });
          spent += 1;
          await deps.store.upsertChannel(channel);
          byName.set(username, { username, status: 'found', channel });
        } catch (error) {
          // Not sent (deadline) or sent again later (rate limit): not charged.
          if (error instanceof DeadlineExceededError) {
            byName.set(username, { username, status: 'pending' });
            continue;
          }
          if (error instanceof RateLimitedError) {
            retryAfterMs = error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
            byName.set(username, { username, status: 'pending' });
            continue;
          }
          const failure = toAddChannelError(error);
          if (failure === undefined) throw error;
          spent += 1;
          byName.set(username, { username, status: failure.reason });
        }
      }
    } finally {
      if (granted > spent) await options.refundLookups(granted - spent);
    }
  }

  return {
    results: usernames.map((username) => byName.get(username) ?? { username, status: 'pending' }),
    retryAfterMs,
  };
}
