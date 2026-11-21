import { afterEach, describe, expect, it, vi } from 'vitest';

import { newspaperCredit, newspaperPromo, UPSTREAM_REPO_URL } from './promo';

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

describe('newspaperCredit', () => {
  it('is on by default, linking the upstream repo', () => {
    expect(newspaperCredit({})).toEqual({ url: 'https://github.com/andreykolokhmatov/podpiska' });
    expect(newspaperCredit({ PODPISKA_CREDIT: '' })).toEqual({ url: UPSTREAM_REPO_URL });
  });

  it.each(['off', '0', 'false', 'OFF'])('is hidden with PODPISKA_CREDIT=%s', (value) => {
    expect(newspaperCredit({ PODPISKA_CREDIT: value })).toBeNull();
  });

  it('keeps the default on an invalid value', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(newspaperCredit({ PODPISKA_CREDIT: 'nah' })).toEqual({ url: UPSTREAM_REPO_URL });
    expect(log).toHaveBeenCalledOnce();
  });

  it('is independent of TELEGRAM_BOT_USERNAME', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = 'podpiska_news_bot';
    expect(newspaperCredit({ TELEGRAM_BOT_USERNAME: bot })).not.toBeNull();
    expect(newspaperCredit({ TELEGRAM_BOT_USERNAME: '@bad!' })).not.toBeNull();
    expect(newspaperCredit({ TELEGRAM_BOT_USERNAME: bot, PODPISKA_CREDIT: 'off' })).toBeNull();
    expect(newspaperPromo({ TELEGRAM_BOT_USERNAME: bot, PODPISKA_CREDIT: 'off' })).not.toBeNull();
    expect(newspaperPromo({ TELEGRAM_BOT_USERNAME: bot, PODPISKA_CREDIT: 'nah' })).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
