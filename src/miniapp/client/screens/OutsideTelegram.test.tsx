import { AppRoot } from '@telegram-apps/telegram-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { fetchBotUsername, OutsideTelegramView } from './OutsideTelegram';

describe('OutsideTelegram', () => {
  it('names no bot and offers no link until the instance bot is known', () => {
    const html = renderToStaticMarkup(<OutsideTelegramView username={null} />);
    expect(html).toContain('Откройте в Telegram');
    expect(html).not.toContain('podpiska_news_bot');
    expect(html).not.toContain('t.me/');
  });

  it('links to the instance bot once known', () => {
    const html = renderToStaticMarkup(
      <AppRoot>
        <OutsideTelegramView username="my_paper_bot" />
      </AppRoot>,
    );
    expect(html).toContain('href="https://t.me/my_paper_bot"');
    expect(html).toContain('Открыть @my_paper_bot');
  });
});

describe('fetchBotUsername', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

  it('reads the username from /api/public/bot', async () => {
    const fetchImpl = respond(200, { username: 'my_paper_bot' });
    await expect(fetchBotUsername(fetchImpl)).resolves.toBe('my_paper_bot');
    expect(fetchImpl).toHaveBeenCalledWith('/api/public/bot');
  });

  it.each([
    ['misconfigured', 500, { error: 'misconfigured' }],
    ['unavailable', 503, { error: 'unavailable' }],
    ['malformed', 200, { username: 'x y' }],
  ])('is null when %s', async (_name, status, body) => {
    await expect(fetchBotUsername(respond(status, body))).resolves.toBeNull();
  });

  it('is null when the network fails', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('offline')));
    await expect(fetchBotUsername(fetchImpl)).resolves.toBeNull();
  });
});
