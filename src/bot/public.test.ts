import { describe, expect, it, vi } from 'vitest';

import { EnvError } from '@/lib/env';

import { createPublicBotHandler, memoizeUsername, PUBLIC_BOT_CACHE } from './public';

describe('GET /api/public/bot', () => {
  it('answers the username with a day of CDN cache', async () => {
    const handler = createPublicBotHandler({ username: async () => 'my_bot', log: vi.fn() });
    const res = await handler();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: 'my_bot' });
    expect(res.headers.get('cache-control')).toBe(PUBLIC_BOT_CACHE);
    expect(PUBLIC_BOT_CACHE).toContain('s-maxage=86400');
  });

  it('answers 500 misconfigured without a token and 503 when getMe fails, never cached', async () => {
    const log = vi.fn();
    const misconfigured = createPublicBotHandler({
      username: () => {
        throw new EnvError('Invalid environment variables:\n  - TELEGRAM_BOT_TOKEN: is required');
      },
      log,
    });
    const down = createPublicBotHandler({
      username: async () => {
        throw new Error('network');
      },
      log,
    });
    const a = await misconfigured();
    const b = await down();
    expect([a.status, await a.json()]).toEqual([500, { error: 'misconfigured' }]);
    expect([b.status, await b.json()]).toEqual([503, { error: 'unavailable' }]);
    expect(a.headers.get('cache-control')).toBe('no-store');
    expect(b.headers.get('cache-control')).toBe('no-store');
  });
});

describe('memoizeUsername', () => {
  it('calls getMe once and retries after a failure', async () => {
    const getMe = vi
      .fn<() => Promise<{ username: string }>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ username: 'my_bot' });
    const username = memoizeUsername(getMe);
    await expect(username()).rejects.toThrow('down');
    expect(await username()).toBe('my_bot');
    expect(await username()).toBe('my_bot');
    expect(getMe).toHaveBeenCalledTimes(2);
  });
});
