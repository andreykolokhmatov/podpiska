import { getMiniAppEnv } from '@/lib/env';
import { createEmojiHandler } from '@/miniapp/emoji';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Proxied, never committed: the animation is © Telegram.
export const GET = createEmojiHandler(
  () => ({ token: getMiniAppEnv().TELEGRAM_BOT_TOKEN }),
  (line) => console.log(line),
);
