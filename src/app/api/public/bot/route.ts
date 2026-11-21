import { Api } from 'grammy';

import { createPublicBotHandler, memoizeUsername } from '@/bot/public';
import { getMiniAppEnv } from '@/lib/env';

export const runtime = 'nodejs';
// Env is read per request (never at build); the CDN caches the answer via s-maxage.
export const dynamic = 'force-dynamic';

const username = memoizeUsername(() => new Api(getMiniAppEnv().TELEGRAM_BOT_TOKEN).getMe());

const handler = createPublicBotHandler({ username, log: console.log });

export function GET(): Promise<Response> {
  return handler();
}
