import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PrivacyPage from './page';

async function render(env: Record<string, string>): Promise<string> {
  vi.stubEnv('PRIVACY_CONTACT', env.PRIVACY_CONTACT ?? '');
  vi.stubEnv('LLM_BASE_URL', env.LLM_BASE_URL ?? '');
  return renderToStaticMarkup(await PrivacyPage({ searchParams: Promise.resolve({}) }));
}

describe('/privacy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names no hosted-instance people or services with an empty env', async () => {
    const html = await render({});
    expect(html).not.toContain('andrei_working');
    expect(html).not.toContain('podpiska_news_bot');
    expect(html).not.toContain('ProxyAPI');
    expect(html).toContain('напрямую в Google Gemini API');
    expect(html).toContain('напишите владельцу бота');
    expect(html).toContain('бесплатный ключ Google AI Studio');
  });

  it('shows the configured contact and proxy host', async () => {
    const html = await render({
      PRIVACY_CONTACT: '@paper_admin',
      LLM_BASE_URL: 'https://api.proxyapi.ru/google/v1beta',
    });
    expect(html).toContain('href="https://t.me/paper_admin"');
    expect(html).toContain('@paper_admin');
    expect(html).toContain('через прокси api.proxyapi.ru');
  });
});
