import { afterEach, describe, expect, it, vi } from 'vitest';

import { newspaperPromo } from './promo';

afterEach(() => vi.restoreAllMocks());

describe('newspaperPromo', () => {
  it('is null when TELEGRAM_BOT_USERNAME is unset or empty', () => {
    expect(newspaperPromo({})).toBeNull();
    expect(newspaperPromo({ TELEGRAM_BOT_USERNAME: ' ' })).toBeNull();
  });

  it('links the bot', () => {
    expect(newspaperPromo({ TELEGRAM_BOT_USERNAME: 'podpiska_news_bot' })).toEqual({
      botUsername: 'podpiska_news_bot',
      url: 'https://t.me/podpiska_news_bot',
    });
  });

  it('hides the plate on an invalid value without echoing it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(newspaperPromo({ TELEGRAM_BOT_USERNAME: '@evil"><script>' })).toBeNull();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('script');
  });
});
