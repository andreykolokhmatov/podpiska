import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  createEmojiHandler,
  fetchNewspaperLottie,
  LOTTIE_MAX_BYTES,
  validateLottie,
} from './emoji';

const TOKEN = '123:SECRET-token';
const lottie = JSON.stringify({ v: '5.5.2', fr: 60, ip: 0, op: 180, w: 512, h: 512, layers: [{}] });

const fakeTelegram = (tgs: Buffer = gzipSync(lottie), stickers?: unknown[]) => {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/getStickerSet')) {
      return Response.json({
        ok: true,
        result: {
          stickers: stickers ?? [
            { emoji: '📄', is_animated: true, file_id: 'other' },
            { emoji: '📰', is_animated: true, file_id: 'news-file' },
          ],
        },
      });
    }
    if (url.includes('/getFile')) {
      return Response.json({ ok: true, result: { file_path: 'stickers/file_1.tgs' } });
    }
    if (url.includes('/file/bot')) return new Response(new Uint8Array(tgs));
    return new Response('nope', { status: 404 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls, mock: fetch };
};

describe('validateLottie', () => {
  it('accepts a minimal Lottie document', () => {
    expect(validateLottie(lottie)).toBe(true);
  });

  it.each([
    ['not json', '{'],
    ['no layers', JSON.stringify({ v: '5', fr: 60, ip: 0, op: 1, layers: [] })],
    ['no frame rate', JSON.stringify({ v: '5', ip: 0, op: 1, layers: [{}] })],
    ['an array', '[]'],
  ])('rejects %s', (_, text) => {
    expect(validateLottie(text)).toBe(false);
  });

  it('rejects an oversized document', () => {
    const big = JSON.stringify({
      v: '5',
      fr: 60,
      ip: 0,
      op: 1,
      layers: [{ pad: 'x'.repeat(LOTTIE_MAX_BYTES) }],
    });
    expect(validateLottie(big)).toBe(false);
  });
});

describe('fetchNewspaperLottie', () => {
  it('finds 📰 in AnimatedEmojies, downloads and gunzips it', async () => {
    const telegram = fakeTelegram();
    await expect(fetchNewspaperLottie({ token: TOKEN, fetch: telegram.fetch })).resolves.toBe(
      lottie,
    );
    expect(telegram.urls[0]).toContain('getStickerSet?name=AnimatedEmojies');
    expect(telegram.urls[1]).toContain('file_id=news-file');
    expect(telegram.urls[2]).toMatch(/\/file\/bot.+\/stickers\/file_1\.tgs$/);
  });

  it('matches the emoji with a variation selector', async () => {
    const telegram = fakeTelegram(undefined, [
      { emoji: '📰️', is_animated: true, file_id: 'news-file' },
    ]);
    await expect(fetchNewspaperLottie({ token: TOKEN, fetch: telegram.fetch })).resolves.toBe(
      lottie,
    );
  });

  it('refuses a file that is not a Lottie, without the token in the error', async () => {
    const telegram = fakeTelegram(gzipSync('{"hello":1}'));
    const error = await fetchNewspaperLottie({ token: TOKEN, fetch: telegram.fetch }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toMatch(/validate/);
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('refuses a decompression bomb', async () => {
    const telegram = fakeTelegram(gzipSync('x'.repeat(LOTTIE_MAX_BYTES * 4)));
    await expect(fetchNewspaperLottie({ token: TOKEN, fetch: telegram.fetch })).rejects.toThrow(
      /gunzip/,
    );
  });
});

describe('createEmojiHandler', () => {
  it('serves cacheable Lottie and fetches Telegram once per instance', async () => {
    const telegram = fakeTelegram();
    const handler = createEmojiHandler(() => ({ token: TOKEN, fetch: telegram.fetch }), vi.fn());
    const res = await handler();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=86400, stale-while-revalidate=604800',
    );
    expect(await res.text()).toBe(lottie);
    await handler();
    expect(telegram.mock).toHaveBeenCalledTimes(3);
  });

  it('answers 503 no-store on failure and logs no token', async () => {
    const telegram = fakeTelegram(undefined, []);
    const log = vi.fn();
    const handler = createEmojiHandler(() => ({ token: TOKEN, fetch: telegram.fetch }), log);
    const res = await handler();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});
