import { describe, expect, it, vi } from 'vitest';

import {
  ChannelUnavailableError,
  CollectorHttpError,
  DeadlineExceededError,
  InvalidChannelError,
  RateLimitedError,
  type ChannelInfo,
} from '@/collector';

import {
  DEFAULT_RETRY_AFTER_MS,
  LookupLimitError,
  resolveChannels,
  type ResolveDeps,
} from './resolve';

const info = (username: string): ChannelInfo => ({
  username,
  displayUsername: username,
  title: username.toUpperCase(),
  avatarUrl: null,
});

const setup = (
  opts: {
    linked?: string[];
    known?: string[];
    fetch?: (username: string) => ChannelInfo | Error;
    /** ms the clock advances on every fetch. */
    fetchMs?: number;
    /** Lookups granted per claim; default: all asked. */
    grant?: number;
    upsert?: () => Promise<void>;
  } = {},
) => {
  let clock = 1_000;
  const store = {
    findAvailableChannels: vi.fn<ResolveDeps['store']['findAvailableChannels']>(async (names) =>
      (opts.known ?? []).filter((n) => names.includes(n)).map(info),
    ),
    listLinkedUsernames: vi.fn<ResolveDeps['store']['listLinkedUsernames']>(async (_u, names) =>
      (opts.linked ?? []).filter((n) => names.includes(n)),
    ),
    upsertChannel: vi.fn<ResolveDeps['store']['upsertChannel']>(opts.upsert ?? (async () => {})),
  };
  const fetchChannelInfo = vi.fn<ResolveDeps['source']['fetchChannelInfo']>(async (username) => {
    clock += opts.fetchMs ?? 1_000;
    const outcome = opts.fetch?.(username) ?? info(username);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const claimLookups = vi.fn(async (count: number) => Math.min(count, opts.grant ?? count));
  const refundLookups = vi.fn<(count: number) => Promise<void>>(async () => {});
  const deps: ResolveDeps = { store, source: { fetchChannelInfo }, now: () => clock };
  const run = (usernames: string[], deadline = 100_000) =>
    resolveChannels(deps, 7, usernames, { deadline, claimLookups, refundLookups });
  const refunded = () => refundLookups.mock.calls.reduce((sum, [count]) => sum + count, 0);
  return { run, store, fetchChannelInfo, claimLookups, refundLookups, refunded };
};

describe('resolveChannels', () => {
  it('answers from links and the cache without scraping or claiming', async () => {
    const { run, fetchChannelInfo, claimLookups, refundLookups } = setup({
      linked: ['chan_one'],
      known: ['chan_one', 'chan_two'],
    });
    const result = await run(['chan_one', 'chan_two', 'news_bot']);
    expect(result.results).toEqual([
      { username: 'chan_one', status: 'subscribed', channel: info('chan_one') },
      { username: 'chan_two', status: 'found', channel: info('chan_two') },
      { username: 'news_bot', status: 'bot' },
    ]);
    expect(fetchChannelInfo).not.toHaveBeenCalled();
    expect(claimLookups).not.toHaveBeenCalled();
    expect(refundLookups).not.toHaveBeenCalled();
  });

  it('never queries or scrapes bot names', async () => {
    const { run, store, fetchChannelInfo } = setup();
    await run(['somebot']);
    expect(store.findAvailableChannels).toHaveBeenCalledWith([]);
    expect(fetchChannelInfo).not.toHaveBeenCalled();
  });

  it('claims only cache misses, scrapes them in order and caches the found ones', async () => {
    const { run, fetchChannelInfo, claimLookups, refundLookups, store } = setup({
      known: ['chan_two'],
    });
    const result = await run(['chan_one', 'chan_two', 'chan_three']);
    expect(claimLookups).toHaveBeenCalledWith(2);
    expect(refundLookups).not.toHaveBeenCalled();
    expect(fetchChannelInfo.mock.calls).toEqual([
      ['chan_one', { deadline: 100_000 }],
      ['chan_three', { deadline: 100_000 }],
    ]);
    expect(store.upsertChannel.mock.calls.map(([c]) => c.username)).toEqual([
      'chan_one',
      'chan_three',
    ]);
    expect(result.results.map((r) => r.status)).toEqual(['found', 'found', 'found']);
  });

  it('throws LookupLimitError before any scrape when no lookup is left', async () => {
    const { run, fetchChannelInfo, refundLookups } = setup({ grant: 0 });
    await expect(run(['chan_one'])).rejects.toBeInstanceOf(LookupLimitError);
    expect(fetchChannelInfo).not.toHaveBeenCalled();
    expect(refundLookups).not.toHaveBeenCalled();
  });

  it('with a partial grant scrapes only the granted ones, the rest stay pending', async () => {
    const { run, fetchChannelInfo, refundLookups } = setup({ grant: 2 });
    const result = await run(['chan_one', 'chan_two', 'chan_three', 'chan_four']);
    expect(fetchChannelInfo.mock.calls.map(([name]) => name)).toEqual(['chan_one', 'chan_two']);
    expect(result.results.map((r) => r.status)).toEqual(['found', 'found', 'pending', 'pending']);
    expect(refundLookups).not.toHaveBeenCalled();
  });

  it.each([
    ['an unexpected fetch error', { fetch: () => new TypeError('boom') }, 3],
    [
      'a failing cache write',
      {
        upsert: async () => {
          throw new Error('db down');
        },
      },
      2,
    ],
  ])('refunds unspent lookups when %s escapes', async (_label, opts, refund) => {
    const { run, refundLookups, refunded } = setup(opts);
    await expect(run(['chan_one', 'chan_two', 'chan_three'])).rejects.toBeInstanceOf(Error);
    expect(refundLookups).toHaveBeenCalledTimes(1);
    expect(refunded()).toBe(refund);
  });

  it.each([
    [new ChannelUnavailableError('not_found_or_preview_disabled', 'x'), 'not_found'],
    [new CollectorHttpError(404, '404'), 'not_found'],
    [new CollectorHttpError(null, 'timeout'), 'retry_later'],
    [new CollectorHttpError(503, '503'), 'retry_later'],
    [new InvalidChannelError('private_link', 'x'), 'private'],
  ])('maps %s to %s without caching', async (error, status) => {
    const { run, store } = setup({ fetch: () => error });
    const result = await run(['chan_one']);
    expect(result.results).toEqual([{ username: 'chan_one', status }]);
    expect(store.upsertChannel).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors', async () => {
    const { run } = setup({ fetch: () => new TypeError('boom') });
    await expect(run(['chan_one'])).rejects.toBeInstanceOf(TypeError);
  });

  it('leaves the rest pending at the deadline and refunds their lookups', async () => {
    const { run, fetchChannelInfo, refunded } = setup({ fetchMs: 5_000 });
    // clock 1000 → 6000 → 11000: the third fetch would start at the deadline.
    const result = await run(['chan_one', 'chan_two', 'chan_three', 'chan_four'], 11_000);
    expect(fetchChannelInfo).toHaveBeenCalledTimes(2);
    expect(result.results.map((r) => r.status)).toEqual(['found', 'found', 'pending', 'pending']);
    expect(refunded()).toBe(2);
  });

  it('a fetch stopped by the deadline after the limiter wait is pending and refunded', async () => {
    const { run, fetchChannelInfo, refunded } = setup({
      fetch: (name) => (name === 'chan_two' ? new DeadlineExceededError('late') : info(name)),
    });
    const result = await run(['chan_one', 'chan_two', 'chan_three']);
    expect(fetchChannelInfo).toHaveBeenCalledTimes(3);
    expect(result.results.map((r) => r.status)).toEqual(['found', 'pending', 'found']);
    expect(refunded()).toBe(1);
  });

  it('stops the batch on a t.me rate limit and passes Retry-After', async () => {
    const { run, fetchChannelInfo, refunded } = setup({
      fetch: (name) => (name === 'chan_two' ? new RateLimitedError('slow', 30_000) : info(name)),
    });
    const result = await run(['chan_one', 'chan_two', 'chan_three']);
    expect(fetchChannelInfo).toHaveBeenCalledTimes(2);
    expect(result.results.map((r) => r.status)).toEqual(['found', 'pending', 'pending']);
    expect(result.retryAfterMs).toBe(30_000);
    expect(refunded()).toBe(2);
  });

  it('defaults the retry delay when t.me sends no Retry-After', async () => {
    const { run } = setup({ fetch: () => new RateLimitedError('slow') });
    expect((await run(['chan_one'])).retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });
});
