import { describe, expect, it, vi } from 'vitest';

import { collectForChannels } from './collect';
import { ChannelUnavailableError } from './errors';
import type { ChannelStore } from './store';
import type { ChannelInfo, ParsedPost, PostSource } from './types';

const since = new Date('2026-11-14T00:00:00Z');

const info = (username: string): ChannelInfo => ({
  username,
  displayUsername: username,
  title: username,
  avatarUrl: null,
});

const post = (tgPostId: number): ParsedPost => ({
  tgPostId,
  text: `post ${tgPostId}`,
  html: null,
  publishedAt: new Date('2026-11-14T12:00:00Z'),
  views: 1,
  hasMedia: false,
});

function makeStore(): ChannelStore & {
  saveChannelPosts: ReturnType<typeof vi.fn>;
  markChannelUnavailable: ReturnType<typeof vi.fn>;
} {
  return {
    saveChannelPosts: vi.fn(async (_info: ChannelInfo, posts: ParsedPost[]) => ({
      collected: posts.length,
      inserted: posts.length,
    })),
    markChannelUnavailable: vi.fn(async () => undefined),
  };
}

describe('collectForChannels', () => {
  it('isolates failures per channel and marks unavailable ones', async () => {
    const source: PostSource = {
      fetchChannel: vi.fn(async (username: string) => {
        if (username === 'missing_chan') {
          throw new ChannelUnavailableError('not_found_or_preview_disabled', 'gone');
        }
        if (username === 'broken_chan') {
          throw new Error('boom');
        }
        return { info: info(username), posts: [post(1), post(2)] };
      }),
      fetchChannelInfo: vi.fn(async (username: string) => info(username)),
    };
    const store = makeStore();

    const results = await collectForChannels(
      ['@good_chan', 'missing_chan', 'broken_chan', 'https://t.me/s/other_chan'],
      since,
      { source, store },
    );

    expect(results).toEqual([
      { username: 'good_chan', ok: true, collected: 2, inserted: 2 },
      expect.objectContaining({ username: 'missing_chan', ok: false, code: 'ChannelUnavailable' }),
      { username: 'broken_chan', ok: false, code: 'Unexpected', message: 'boom' },
      { username: 'other_chan', ok: true, collected: 2, inserted: 2 },
    ]);
    expect(store.markChannelUnavailable).toHaveBeenCalledExactlyOnceWith('missing_chan');
    expect(store.saveChannelPosts).toHaveBeenCalledTimes(2);
  });

  it('reports invalid input without fetching, and dedupes channels', async () => {
    const source: PostSource = {
      fetchChannel: vi.fn(async (username: string) => ({ info: info(username), posts: [] })),
      fetchChannelInfo: vi.fn(async (username: string) => info(username)),
    };
    const results = await collectForChannels(['t.me/+invite', '@Good_Chan', 'good_chan'], since, {
      source,
      store: makeStore(),
    });
    expect(results).toEqual([
      expect.objectContaining({ username: 't.me/+invite', ok: false, code: 'InvalidChannel' }),
      { username: 'good_chan', ok: true, collected: 0, inserted: 0 },
    ]);
    expect(source.fetchChannel).toHaveBeenCalledExactlyOnceWith('good_chan', since);
  });

  it('runs at most `concurrency` channels at once', async () => {
    let active = 0;
    let maxActive = 0;
    const source: PostSource = {
      fetchChannel: vi.fn(async (username: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { info: info(username), posts: [] };
      }),
      fetchChannelInfo: vi.fn(async (username: string) => info(username)),
    };
    const inputs = Array.from({ length: 10 }, (_, i) => `channel_${i}x`);
    const results = await collectForChannels(inputs, since, { source, store: makeStore() });
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxActive).toBe(4);
  });
});
