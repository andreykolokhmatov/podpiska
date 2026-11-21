import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { EnvError, getCronEnv, type EnvSource } from '@/lib/env';

import {
  SETUP_ACTIONS,
  type Check,
  type SetupChecksResponse,
  type SetupCronResponse,
  type SetupErrorCode,
} from './contract';

export interface SetupApiDeps {
  env: () => EnvSource;
  checks: () => Promise<Check[]>;
  /** Webhook, commands and menu button from APP_URL; nothing comes from the request. */
  configureBot: () => Promise<void>;
  now: () => number;
  /** Metadata only: never the body, the token or any env value. */
  log: (line: string) => void;
}

export const CHECKS_TTL_MS = 60_000;
export const FAILED_TOKENS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;
/** Bounds the limiter's memory under a spray of addresses. */
const MAX_TRACKED_CLIENTS = 1_000;
const MAX_BODY_BYTES = 4_096;
const BOT_TOKEN_PATTERN = /^\d+:[\w-]+$/;

const requestSchema = z.object({
  token: z.string().max(256),
  action: z.enum(SETUP_ACTIONS),
});

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: NO_STORE });
const fail = (status: number, error: SetupErrorCode): Response => json(status, { error });

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time: digests make the lengths equal, so neither length nor prefix leaks. */
export function tokenMatches(given: string, expected: string): boolean {
  if (expected.length === 0) return false;
  return timingSafeEqual(digest(given.trim()), digest(expected));
}

const clientKey = (req: Request): string =>
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  req.headers.get('x-real-ip')?.trim() ||
  'unknown';

const redact = (message: string, secret: string): string =>
  secret.length >= 4 ? message.split(secret).join('[redacted]') : message;

export function createSetupApi(deps: SetupApiDeps): (req: Request) => Promise<Response> {
  const failures = new Map<string, number[]>();
  let cached: { at: number; result: Promise<SetupChecksResponse> } | undefined;

  const recentFailures = (key: string, now: number): number[] => {
    const recent = (failures.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length === 0) failures.delete(key);
    else failures.set(key, recent);
    return recent;
  };

  const recordFailure = (key: string, now: number): void => {
    if (!failures.has(key) && failures.size >= MAX_TRACKED_CLIENTS) {
      for (const [other, times] of failures) {
        if (times.every((at) => now - at >= RATE_WINDOW_MS)) failures.delete(other);
      }
      // Still full: drop the oldest entry rather than grow without bound.
      if (failures.size >= MAX_TRACKED_CLIENTS) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
    }
    failures.set(key, [...recentFailures(key, now), now]);
  };

  const freshChecks = (): Promise<SetupChecksResponse> => {
    const checkedAt = new Date(deps.now()).toISOString();
    const result = deps.checks().then((checks) => ({ checks, checkedAt }));
    cached = { at: deps.now(), result };
    // A failed run must not be served from the cache.
    result.catch(() => {
      if (cached?.result === result) cached = undefined;
    });
    return result;
  };

  const cachedChecks = (): Promise<SetupChecksResponse> =>
    cached !== undefined && deps.now() - cached.at < CHECKS_TTL_MS ? cached.result : freshChecks();

  return async (req) => {
    try {
      const key = clientKey(req);
      if (recentFailures(key, deps.now()).length >= FAILED_TOKENS_PER_MINUTE) {
        return fail(429, 'rate_limited');
      }

      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return fail(400, 'bad_request');
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return fail(400, 'bad_request');
      }
      const parsed = requestSchema.safeParse(value);
      if (!parsed.success) {
        // A body without a usable token is a failed attempt too.
        recordFailure(key, deps.now());
        return fail(400, 'bad_request');
      }

      const expected = deps.env().TELEGRAM_BOT_TOKEN?.trim() ?? '';
      // No deploy token: nothing to authenticate against, and the caller learns nothing more.
      const deployTokenOk = BOT_TOKEN_PATTERN.test(expected);
      if (!deployTokenOk) deps.log('[setup] TELEGRAM_BOT_TOKEN missing or malformed');
      if (!deployTokenOk || !tokenMatches(parsed.data.token, expected)) {
        recordFailure(key, deps.now());
        return fail(401, 'unauthorized');
      }

      const { action } = parsed.data;
      if (action === 'cron') {
        const env = getCronEnv(deps.env());
        const body: SetupCronResponse = {
          url: `${env.APP_URL}/api/cron/tick`,
          method: 'POST',
          header: 'Authorization',
          value: `Bearer ${env.CRON_SECRET}`,
        };
        return json(200, body);
      }

      if (action === 'apply') {
        // A preview deploy would repoint the production bot at itself.
        const vercelEnv = deps.env().VERCEL_ENV?.trim();
        if (vercelEnv !== undefined && vercelEnv !== '' && vercelEnv !== 'production') {
          return fail(409, 'not_production');
        }
        let apply: SetupChecksResponse['apply'];
        try {
          await deps.configureBot();
          apply = { ok: true };
        } catch (error) {
          const message =
            error instanceof Error ? redact(error.message, expected) : 'unknown error';
          deps.log(`[setup] apply: ${error instanceof Error ? error.name : 'unknown'} error`);
          apply = { ok: false, error: message };
        }
        const result = await freshChecks();
        return json(200, { ...result, apply } satisfies SetupChecksResponse);
      }

      return json(200, await cachedChecks());
    } catch (error) {
      if (error instanceof EnvError) {
        // EnvError messages list keys and reasons only, never values.
        deps.log(`[setup] misconfigured: ${error.message}`);
        return fail(500, 'misconfigured');
      }
      deps.log(`[setup] ${error instanceof Error ? error.name : 'unknown'} error`);
      return fail(500, 'internal');
    }
  };
}
