import { createHash, timingSafeEqual } from 'node:crypto';

import { type Bot, webhookCallback } from 'grammy';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time comparison; hashing first makes the lengths equal. */
export function verifySecretToken(header: string | null, secret: string): boolean {
  if (header === null) return false;
  return timingSafeEqual(digest(header), digest(secret));
}

export interface WebhookHandlerDeps {
  secret: string;
  getBot: () => Promise<Bot>;
  log: (line: string) => void;
}

/**
 * The secret is checked before the bot is created or initialised, so unauthenticated
 * requests never cost a getMe call. Handler failures still answer 200: a non-2xx makes
 * Telegram redeliver the same update over and over.
 */
export function createWebhookHandler(
  deps: WebhookHandlerDeps,
): (req: Request) => Promise<Response> {
  let callback: ((req: Request) => Promise<Response>) | undefined;

  return async (req) => {
    if (!verifySecretToken(req.headers.get(SECRET_HEADER), deps.secret)) {
      return new Response('unauthorized', { status: 401 });
    }
    try {
      if (callback === undefined) {
        const bot = await deps.getBot();
        callback = webhookCallback(bot, 'std/http', {
          secretToken: deps.secret,
          onTimeout: 'return',
          // Below the route's maxDuration (30s) so the function answers before Vercel kills it.
          timeoutMilliseconds: 25_000,
        });
      }
      return await callback(req);
    } catch (error) {
      deps.log(`webhook error: ${error instanceof Error ? error.name : typeof error}`);
      return new Response(null, { status: 200 });
    }
  };
}
