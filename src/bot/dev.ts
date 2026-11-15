import 'dotenv/config';

import { parseArgs } from 'node:util';

import { closeDb } from '@/db';

import { createAppBot } from '.';

const PROD_BOT = 'podpiska_news_bot';

/** Long polling for the dev bot. Refuses to touch a bot that has a webhook (likely prod). */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      force: { type: 'boolean', default: false },
      'expect-bot': { type: 'string' },
    },
  });
  const bot = createAppBot();

  const me = await bot.api.getMe();
  bot.botInfo = me;
  console.log(`bot: @${me.username}`);

  const username = me.username.toLowerCase();
  const expected = values['expect-bot']?.replace(/^@/, '').toLowerCase();
  if (expected !== undefined && expected !== username) {
    console.error(`token belongs to @${me.username}, expected @${expected}; refusing to poll`);
    return 1;
  }
  if (username === PROD_BOT && !values.force) {
    console.error(`@${me.username} is the prod bot; refusing to poll. Use --force to override.`);
    return 1;
  }

  const info = await bot.api.getWebhookInfo();
  if (info.url !== '') {
    if (!values.force) {
      console.error(
        `@${me.username} has a webhook set (probably prod); refusing to poll. Use --force to delete it.`,
      );
      return 1;
    }
    await bot.api.deleteWebhook();
    console.log('webhook deleted (--force)');
  }

  const stop = (): void => {
    void bot.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await bot.start({
      allowed_updates: ['message'],
      onStart: () => console.log('polling started; Ctrl+C to stop'),
    });
  } finally {
    await closeDb();
  }
  console.log('stopped');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  async (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown error');
    await closeDb();
    process.exitCode = 1;
  },
);
