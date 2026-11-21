import type { Api } from 'grammy';

import { texts } from './texts';

export type ConfigureApi = Pick<Api, 'setWebhook' | 'setMyCommands' | 'setChatMenuButton'>;
export type StatusApi = Pick<Api, 'getMe' | 'getWebhookInfo' | 'getChatMenuButton'>;

export interface ConfigureOptions {
  /** APP_URL (configured or derived), never a request's Host header. */
  appUrl: string;
  webhookSecret: string;
}

const isLocalHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname === '0.0.0.0';

export class BotConfigError extends Error {
  override readonly name = 'BotConfigError';
}

/** Telegram only reaches public https URLs; anything else would silently break the bot. */
export function assertPublicAppUrl(appUrl: string): URL {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new BotConfigError('APP_URL must be a public https URL');
  }
  if (url.protocol !== 'https:' || isLocalHost(url.hostname)) {
    throw new BotConfigError('APP_URL must be a public https URL (not localhost)');
  }
  return url;
}

export const webhookUrlOf = (appUrl: string): string => `${appUrl.replace(/\/+$/, '')}/api/bot`;
const menuUrlOf = (appUrl: string): string => appUrl.replace(/\/+$/, '');

/**
 * Points the bot at the app: webhook (message updates only), /start command, Mini App menu
 * button. Idempotent. The Main Mini App (profile "Open" button) cannot be set via the Bot API.
 */
export async function configureBot(api: ConfigureApi, options: ConfigureOptions): Promise<void> {
  assertPublicAppUrl(options.appUrl);
  await api.setWebhook(webhookUrlOf(options.appUrl), {
    secret_token: options.webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
  await api.setMyCommands([{ command: 'start', description: texts.startCommand }]);
  await api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: texts.menuButton,
      web_app: { url: menuUrlOf(options.appUrl) },
    },
  });
}

export interface BotStatus {
  username: string;
  /** Main Mini App enabled in BotFather; without it shared issue cards do not open the app. */
  hasMainWebApp: boolean;
  webhook: {
    url: string;
    /** '' when no webhook is set; ok: url equals APP_URL/api/bot. */
    ok: boolean;
    pendingUpdateCount: number;
    lastErrorDate: Date | null;
    lastErrorMessage: string | null;
  };
  menuButton: {
    type: string;
    url: string | null;
    /** A web_app button opening APP_URL. */
    ok: boolean;
  };
}

/** Read-only snapshot of how Telegram sees the bot, compared against APP_URL. */
export async function botStatus(api: StatusApi, appUrl: string): Promise<BotStatus> {
  const [me, info, menu] = await Promise.all([
    api.getMe(),
    api.getWebhookInfo(),
    api.getChatMenuButton(),
  ]);
  const menuUrl = menu.type === 'web_app' ? (menu.web_app.url ?? null) : null;
  return {
    username: me.username,
    hasMainWebApp: me.has_main_web_app === true,
    webhook: {
      url: info.url ?? '',
      ok: info.url === webhookUrlOf(appUrl),
      pendingUpdateCount: info.pending_update_count,
      lastErrorDate:
        info.last_error_date === undefined ? null : new Date(info.last_error_date * 1000),
      lastErrorMessage: info.last_error_message ?? null,
    },
    menuButton: {
      type: menu.type,
      url: menuUrl,
      ok: menuUrl !== null && menuUrlOf(menuUrl) === menuUrlOf(appUrl),
    },
  };
}

export class BotMismatchError extends Error {
  override readonly name = 'BotMismatchError';
}

/** `@Name` or `name` → `name`; '' when nothing usable was given. */
export const normalizeBotUsername = (raw: string | undefined): string =>
  (raw ?? '').trim().replace(/^@/, '').toLowerCase();

/**
 * configureBot behind a getMe guard: refuses (BotMismatchError, nothing changed) unless the
 * token belongs to `expected`, so a stray .env never repoints another bot. Returns the username.
 */
export async function configureExpectedBot(
  api: ConfigureApi & Pick<Api, 'getMe'>,
  expected: string,
  options: ConfigureOptions,
): Promise<string> {
  const want = normalizeBotUsername(expected);
  const me = await api.getMe();
  if (want === '' || me.username.toLowerCase() !== want) {
    throw new BotMismatchError(
      `token belongs to @${me.username}, expected @${want}; nothing changed`,
    );
  }
  await configureBot(api, options);
  return me.username;
}
