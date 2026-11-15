import 'dotenv/config';

import { parseArgs } from 'node:util';

import { Api } from 'grammy';

import { getBotEnv } from '@/lib/env';

import { texts } from './texts';

const USAGE = 'Usage: pnpm bot:setup --expect-bot <bot_username>';

const isLocalHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname === '0.0.0.0';

/** Points a bot (prod) at APP_URL: webhook, commands and the Mini App menu button. */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { 'expect-bot': { type: 'string' } } });
  const expected = values['expect-bot']?.replace(/^@/, '').toLowerCase();
  if (expected === undefined || expected === '') {
    console.error(USAGE);
    return 2;
  }

  const env = getBotEnv();
  const appUrl = new URL(env.APP_URL);
  if (appUrl.protocol !== 'https:' || isLocalHost(appUrl.hostname)) {
    console.error('APP_URL must be a public https URL (not localhost)');
    return 2;
  }

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const me = await api.getMe();
  if (me.username.toLowerCase() !== expected) {
    console.error(`token belongs to @${me.username}, expected @${expected}; nothing changed`);
    return 1;
  }

  const webhookUrl = `${env.APP_URL}/api/bot`;
  await api.setWebhook(webhookUrl, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
  await api.setMyCommands([{ command: 'start', description: texts.startCommand }]);
  await api.setChatMenuButton({
    menu_button: { type: 'web_app', text: texts.menuButton, web_app: { url: env.APP_URL } },
  });

  const info = await api.getWebhookInfo();
  console.log(`@${me.username} configured`);
  console.log(
    JSON.stringify(
      {
        url: info.url,
        pending_update_count: info.pending_update_count,
        allowed_updates: info.allowed_updates,
        last_error_date: info.last_error_date,
        last_error_message: info.last_error_message,
        max_connections: info.max_connections,
      },
      null,
      2,
    ),
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  },
);
