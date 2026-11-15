import type { Bot } from 'grammy';

import { addUserChannel, createChannelsDbStore, createInteractiveSource } from '@/channels';
import { getDb } from '@/db';
import { EnvError, getBotEnv } from '@/lib/env';

import { createBot } from './bot';
import { createBotDbStore } from './store';
import { createWebhookHandler } from './webhook';

const log = (line: string): void => console.log(line);

/** Wires the bot to the real database and t.me; used by the webhook and `pnpm bot:dev`. */
export function createAppBot(options: { log?: (line: string) => void } = {}): Bot {
  const env = getBotEnv();
  const db = getDb();
  const channelDeps = { store: createChannelsDbStore(db), source: createInteractiveSource() };
  return createBot({
    token: env.TELEGRAM_BOT_TOKEN,
    store: createBotDbStore(db),
    addChannel: (userId, username, limit) => addUserChannel(channelDeps, userId, username, limit),
    appUrl: env.APP_URL,
    maxChannels: env.MAX_CHANNELS_PER_USER,
    log: options.log ?? log,
  });
}

let botPromise: Promise<Bot> | undefined;

/** One initialised bot per (serverless) process; a failed init is retried next time. */
export function getBot(): Promise<Bot> {
  botPromise ??= (async () => {
    const bot = createAppBot();
    await bot.init();
    return bot;
  })().catch((error: unknown) => {
    botPromise = undefined;
    throw error;
  });
  return botPromise;
}

let webhookHandler: ((req: Request) => Promise<Response>) | undefined;

/**
 * Env is read on the first request, never at import time (keeps `next build` secret-free).
 * A misconfigured env answers 200: a non-2xx makes Telegram redeliver forever.
 */
export async function handleWebhook(req: Request): Promise<Response> {
  try {
    webhookHandler ??= createWebhookHandler({
      secret: getBotEnv().TELEGRAM_WEBHOOK_SECRET,
      getBot,
      log,
    });
  } catch (error) {
    // EnvError messages list keys and reasons only, never values.
    log(`webhook misconfigured: ${error instanceof EnvError ? error.message : 'unknown error'}`);
    return new Response(null, { status: 200 });
  }
  return webhookHandler(req);
}
