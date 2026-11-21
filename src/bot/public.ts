import { EnvError } from '@/lib/env';

export interface PublicBotDeps {
  /** The bot's username without @; may throw EnvError (no token) or a Bot API error. */
  username: () => Promise<string>;
  log: (line: string) => void;
}

export interface PublicBotResponse {
  username: string;
}

/** A day at the CDN: the username of a bot practically never changes. */
export const PUBLIC_BOT_CACHE = 'public, s-maxage=86400, stale-while-revalidate=86400';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** GET /api/public/bot → { username }. Public: the client names the bot without a hardcode. */
export function createPublicBotHandler(deps: PublicBotDeps): () => Promise<Response> {
  return async () => {
    try {
      const body: PublicBotResponse = { username: await deps.username() };
      return Response.json(body, { headers: { 'Cache-Control': PUBLIC_BOT_CACHE } });
    } catch (error) {
      if (error instanceof EnvError) {
        // EnvError messages list keys and reasons only, never values.
        deps.log(`[public/bot] misconfigured: ${error.message}`);
        return Response.json({ error: 'misconfigured' }, { status: 500, headers: NO_STORE });
      }
      deps.log(`[public/bot] getMe failed: ${error instanceof Error ? error.name : 'unknown'}`);
      return Response.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
    }
  };
}

/** One getMe per process; a failure is not remembered, so the next call retries. */
export function memoizeUsername(getMe: () => Promise<{ username: string }>): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= getMe().then(
      (me) => me.username,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}
