import 'dotenv/config';

import { parseArgs } from 'node:util';

import { Api } from 'grammy';

import { getBotEnv } from '@/lib/env';

import { botStatus, configureBot } from './configure';

const USAGE = 'Usage: pnpm bot:setup --expect-bot <bot_username>';

/** Points a bot at APP_URL: webhook, commands and the Mini App menu button. */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { 'expect-bot': { type: 'string' } } });
  const expected = values['expect-bot']?.replace(/^@/, '').toLowerCase();
  if (expected === undefined || expected === '') {
    console.error(USAGE);
    return 2;
  }

  const env = getBotEnv();
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const me = await api.getMe();
  if (me.username.toLowerCase() !== expected) {
    console.error(`token belongs to @${me.username}, expected @${expected}; nothing changed`);
    return 1;
  }

  await configureBot(api, { appUrl: env.APP_URL, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET });
  const status = await botStatus(api, env.APP_URL);
  console.log(`@${me.username} configured`);
  console.log(JSON.stringify(status, null, 2));
  if (!status.hasMainWebApp) {
    console.log('Main Mini App is off: BotFather → your bot → Bot Settings → Configure Mini App.');
  }
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
