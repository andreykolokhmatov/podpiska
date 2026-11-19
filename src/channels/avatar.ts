import type { ChannelInfo } from '@/collector/types';
import { normalizeChannel } from '@/collector/normalize';

/** Edge-cached for a day; the stored t.me CDN URL expires sooner, so we serve bytes, not a redirect. */
const CACHE_OK = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
const CACHE_MISS = 'public, max-age=600, s-maxage=3600';
const MAX_BYTES = 512 * 1024;

export interface AvatarDeps {
  /** Only channels already in our DB are served, so the route cannot be used to scrape arbitrary names. */
  findAvatarUrl(username: string): Promise<{ avatarUrl: string | null } | undefined>;
  fetchChannelInfo(username: string): Promise<ChannelInfo>;
  saveAvatarUrl(username: string, avatarUrl: string): Promise<void>;
  fetchImage(url: string): Promise<Response>;
  log?(message: string): void;
}

/** t.me avatars live on Telegram's CDN; anything else in a stored or scraped URL is refused. */
export const isTelegramCdnUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'telesco.pe' ||
        url.hostname.endsWith('.telesco.pe') ||
        url.hostname.endsWith('.t.me'))
    );
  } catch {
    return false;
  }
};

const miss = (status: number): Response =>
  new Response(null, { status, headers: { 'cache-control': CACHE_MISS } });

/** Proxies a channel avatar, re-scraping a fresh CDN URL when the stored one has expired. */
export function createAvatarHandler(deps: AvatarDeps) {
  const tryImage = async (url: string | null): Promise<Response | undefined> => {
    if (url === null || !isTelegramCdnUrl(url)) return undefined;
    try {
      const res = await deps.fetchImage(url);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return undefined;
      const body = await res.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return undefined;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': type, 'cache-control': CACHE_OK },
      });
    } catch {
      return undefined;
    }
  };

  return async (rawUsername: string): Promise<Response> => {
    let username: string;
    try {
      username = normalizeChannel(rawUsername);
    } catch {
      return miss(404);
    }
    const row = await deps.findAvatarUrl(username);
    if (row === undefined) return miss(404);

    const cached = await tryImage(row.avatarUrl);
    if (cached !== undefined) return cached;

    let fresh: string | null;
    try {
      fresh = (await deps.fetchChannelInfo(username)).avatarUrl;
    } catch {
      return miss(502);
    }
    if (fresh === null) return miss(404);
    const served = await tryImage(fresh);
    if (served === undefined) return miss(502);
    if (fresh !== row.avatarUrl) {
      await deps.saveAvatarUrl(username, fresh).catch(() => {
        deps.log?.(`[avatar] ${username}: could not store refreshed url`);
      });
    }
    return served;
  };
}

/** Same-origin path the Mini App renders; null when the channel has no avatar at all. */
export const avatarPath = (username: string, avatarUrl: string | null): string | null =>
  avatarUrl === null ? null : `/api/avatars/${username}`;
