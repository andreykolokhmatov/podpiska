import { describe, expect, it, vi } from 'vitest';

import {
  BotConfigError,
  botStatus,
  configureBot,
  webhookUrlOf,
  type ConfigureApi,
  type StatusApi,
} from './configure';
import { texts } from './texts';

const APP_URL = 'https://podpiska.example.com';

const configureApi = () => {
  const calls: string[] = [];
  const api = {
    setWebhook: vi.fn(async () => {
      calls.push('setWebhook');
      return true as const;
    }),
    setMyCommands: vi.fn(async () => {
      calls.push('setMyCommands');
      return true as const;
    }),
    setChatMenuButton: vi.fn(async () => {
      calls.push('setChatMenuButton');
      return true as const;
    }),
  };
  return { api: api as unknown as ConfigureApi & typeof api, calls };
};

describe('configureBot', () => {
  it('sets the webhook, the /start command and the Mini App menu button', async () => {
    const { api, calls } = configureApi();
    await configureBot(api, { appUrl: `${APP_URL}/`, webhookSecret: 'secret_1' });
    expect(calls).toEqual(['setWebhook', 'setMyCommands', 'setChatMenuButton']);
    expect(api.setWebhook).toHaveBeenCalledWith(`${APP_URL}/api/bot`, {
      secret_token: 'secret_1',
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
    expect(api.setMyCommands).toHaveBeenCalledWith([
      { command: 'start', description: texts.startCommand },
    ]);
    expect(api.setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: 'web_app', text: texts.menuButton, web_app: { url: APP_URL } },
    });
  });

  it.each(['http://podpiska.example.com', 'https://localhost:3000', 'not a url'])(
    'refuses %s before touching Telegram',
    async (appUrl) => {
      const { api, calls } = configureApi();
      await expect(configureBot(api, { appUrl, webhookSecret: 's' })).rejects.toBeInstanceOf(
        BotConfigError,
      );
      expect(calls).toEqual([]);
    },
  );
});

describe('botStatus', () => {
  const statusApi = (overrides: {
    url?: string;
    menu?: unknown;
    hasMain?: boolean;
    lastError?: { date: number; message: string };
  }): StatusApi =>
    ({
      getMe: async () => ({ username: 'my_bot', has_main_web_app: overrides.hasMain ?? false }),
      getWebhookInfo: async () => ({
        url: overrides.url ?? '',
        has_custom_certificate: false,
        pending_update_count: 2,
        ...(overrides.lastError === undefined
          ? {}
          : {
              last_error_date: overrides.lastError.date,
              last_error_message: overrides.lastError.message,
            }),
      }),
      getChatMenuButton: async () => overrides.menu ?? { type: 'default' },
    }) as unknown as StatusApi;

  it('reports a fully configured bot', async () => {
    const status = await botStatus(
      statusApi({
        url: webhookUrlOf(APP_URL),
        hasMain: true,
        menu: { type: 'web_app', text: 'Открыть', web_app: { url: APP_URL } },
      }),
      APP_URL,
    );
    expect(status).toEqual({
      username: 'my_bot',
      hasMainWebApp: true,
      webhook: {
        url: `${APP_URL}/api/bot`,
        ok: true,
        pendingUpdateCount: 2,
        lastErrorDate: null,
        lastErrorMessage: null,
      },
      menuButton: { type: 'web_app', url: APP_URL, ok: true },
    });
  });

  it('flags a foreign webhook, a default menu and the last webhook error', async () => {
    const status = await botStatus(
      statusApi({
        url: 'https://elsewhere.example/api/bot',
        lastError: { date: 1_800_000_000, message: 'Wrong response from the webhook: 500' },
      }),
      APP_URL,
    );
    expect(status.webhook.ok).toBe(false);
    expect(status.webhook.lastErrorMessage).toContain('500');
    expect(status.webhook.lastErrorDate).toEqual(new Date(1_800_000_000_000));
    expect(status.menuButton).toEqual({ type: 'default', url: null, ok: false });
    expect(status.hasMainWebApp).toBe(false);
  });
});
