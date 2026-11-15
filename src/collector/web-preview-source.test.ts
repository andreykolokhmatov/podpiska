import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { type FetchImpl, HostLimiter } from './http';
import { WebPreviewSource } from './web-preview-source';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}.html`, import.meta.url), 'utf8');

// Older page for toporlive: synthetic markup re-labelled, ids 100..103 on 2026-11-14 10:00-12:00Z.
const olderPage = fixture('synthetic').replaceAll('Synth_Chan', 'toporlive');

function source(pages: Record<string, string>) {
  const fetchImpl = vi.fn<FetchImpl>(async (url) => {
    const body = pages[url];
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(body, { status: 200 });
  });
  const src = new WebPreviewSource({
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
    limiter: new HostLimiter(0, 0),
  });
  return { src, fetchImpl };
}

describe('WebPreviewSource.fetchChannel', () => {
  it('paginates past the first page until the window is covered', async () => {
    const { src, fetchImpl } = source({
      'https://t.me/s/toporlive': fixture('toporlive'),
      'https://t.me/s/toporlive?before=207402': olderPage,
    });
    const { info, posts } = await src.fetchChannel('toporlive', new Date('2026-11-14T11:30:00Z'));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(info.title).toBe('Топор Live');
    expect(posts).toHaveLength(16);
    expect(posts[0]?.tgPostId).toBe(103);
    const ids = posts.map((post) => post.tgPostId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('stops on the first page when its oldest post is before `since`', async () => {
    const { src, fetchImpl } = source({ 'https://t.me/s/toporlive': fixture('toporlive') });
    const { posts } = await src.fetchChannel('toporlive', new Date('2026-11-15T04:00:00Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(posts.map((post) => post.tgPostId)).toEqual([207419, 207420, 207421]);
  });

  it('stops when the cursor does not decrease', async () => {
    const { src, fetchImpl } = source({
      'https://t.me/s/toporlive': fixture('toporlive'),
      'https://t.me/s/toporlive?before=207402': fixture('toporlive'),
    });
    const { posts } = await src.fetchChannel('toporlive', new Date('2020-01-01T00:00:00Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(posts).toHaveLength(15);
  });
});
