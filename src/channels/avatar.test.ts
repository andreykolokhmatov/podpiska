import { describe, expect, it, vi } from 'vitest';

import { avatarPath, createAvatarHandler, isTelegramCdnUrl, type AvatarDeps } from './avatar';

const STORED = 'https://cdn4.telesco.pe/file/stored.jpg';
const FRESH = 'https://cdn5.telesco.pe/file/fresh.jpg';

const image = (bytes = 3, type = 'image/jpeg') =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });

const setup = (overrides: Partial<AvatarDeps> = {}) => {
  const deps: AvatarDeps = {
    findAvatarUrl: vi.fn(async () => ({ avatarUrl: STORED })),
    fetchChannelInfo: vi.fn(async (username: string) => ({
      username,
      displayUsername: username,
      title: 'T',
      avatarUrl: FRESH,
    })),
    saveAvatarUrl: vi.fn(async () => {}),
    fetchImage: vi.fn(async () => image()),
    ...overrides,
  };
  return { deps, handle: createAvatarHandler(deps) };
};

describe('avatar proxy', () => {
  it('serves the stored avatar with a long edge cache and no re-scrape', async () => {
    const { deps, handle } = setup();
    const res = await handle('Topor');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
    expect(deps.findAvatarUrl).toHaveBeenCalledWith('topor');
    expect(deps.fetchChannelInfo).not.toHaveBeenCalled();
  });

  it('re-scrapes and stores a fresh URL when the stored one has expired', async () => {
    const fetchImage = vi.fn(async (url: string) =>
      url === STORED ? new Response('gone', { status: 403 }) : image(),
    );
    const { deps, handle } = setup({ fetchImage });
    const res = await handle('topor');
    expect(res.status).toBe(200);
    expect(deps.fetchChannelInfo).toHaveBeenCalledWith('topor');
    expect(deps.saveAvatarUrl).toHaveBeenCalledWith('topor', FRESH);
  });

  it('refuses channels we have never seen, without touching t.me', async () => {
    const { deps, handle } = setup({ findAvatarUrl: vi.fn(async () => undefined) });
    expect((await handle('unknown_channel')).status).toBe(404);
    expect(deps.fetchChannelInfo).not.toHaveBeenCalled();
    expect(deps.fetchImage).not.toHaveBeenCalled();
  });

  it('rejects invalid usernames', async () => {
    const { deps, handle } = setup();
    expect((await handle('../etc')).status).toBe(404);
    expect(deps.findAvatarUrl).not.toHaveBeenCalled();
  });

  it('never fetches a non-Telegram URL, even if one was stored or scraped', async () => {
    const { deps, handle } = setup({
      findAvatarUrl: vi.fn(async () => ({ avatarUrl: 'http://169.254.169.254/x' })),
      fetchChannelInfo: vi.fn(async (username: string) => ({
        username,
        displayUsername: username,
        title: null,
        avatarUrl: 'https://evil.example/x.jpg',
      })),
    });
    expect((await handle('topor')).status).toBe(502);
    expect(deps.fetchImage).not.toHaveBeenCalled();
  });

  it('answers 502 with a short cache when t.me fails, and 404 when the channel has no photo', async () => {
    const expired = vi.fn(async () => new Response(null, { status: 403 }));
    const failing = setup({
      fetchImage: expired,
      fetchChannelInfo: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    const res = await failing.handle('topor');
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');

    const noPhoto = setup({
      fetchImage: expired,
      fetchChannelInfo: vi.fn(async (username: string) => ({
        username,
        displayUsername: username,
        title: null,
        avatarUrl: null,
      })),
    });
    expect((await noPhoto.handle('topor')).status).toBe(404);
  });

  it('rejects non-image and oversized bodies', async () => {
    const html = setup({ fetchImage: vi.fn(async () => image(3, 'text/html')) });
    expect((await html.handle('topor')).status).toBe(502);
    const huge = setup({ fetchImage: vi.fn(async () => image(600 * 1024)) });
    expect((await huge.handle('topor')).status).toBe(502);
  });
});

describe('isTelegramCdnUrl', () => {
  it.each([
    ['https://cdn4.telesco.pe/file/a.jpg', true],
    ['https://telesco.pe/a.jpg', true],
    ['https://cdn1.t.me/a.jpg', true],
    ['http://cdn4.telesco.pe/a.jpg', false],
    ['https://telesco.pe.evil.com/a.jpg', false],
    ['https://evilt.me/a.jpg', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(isTelegramCdnUrl(url)).toBe(ok);
  });
});

describe('avatarPath', () => {
  it('points at the proxy only when the channel has an avatar', () => {
    expect(avatarPath('topor', STORED)).toBe('/api/avatars/topor');
    expect(avatarPath('topor', null)).toBeNull();
  });
});
