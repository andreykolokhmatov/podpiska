import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleWebhook } from '.';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('handleWebhook', () => {
  it('answers 200 and logs only key names when the bot env is missing', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    vi.stubEnv('APP_URL', 'http://not-https.example');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await handleWebhook(
      new Request('https://podpiska.example.com/api/bot', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(200);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toMatch(/^webhook misconfigured: /);
    expect(line).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(line).not.toContain('not-https.example');
  });
});
