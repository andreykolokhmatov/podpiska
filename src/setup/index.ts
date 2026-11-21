import { sql } from 'drizzle-orm';
import { Api } from 'grammy';
import { z } from 'zod';

import journal from '../../drizzle/meta/_journal.json';
import { configureBot, configureExpectedBot } from '@/bot/configure';
import { getDb } from '@/db';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '@/db/migrate';
import { getBotEnv, type EnvSource } from '@/lib/env';
import { countOverdueSchedules } from '@/schedule/store';

import { createSetupApi } from './api';
import { runChecks, type CheckDeps, type SetupDb } from './checks';

// Imported (not read from disk) so the serverless bundle carries it.
export const EXPECTED_MIGRATIONS = z
  .object({ entries: z.array(z.object({ tag: z.string() })) })
  .parse(journal).entries.length;

const MIGRATIONS = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;

/** Read-only probes over the app's pooled connection. */
export function createSetupDb(): SetupDb {
  const db = getDb();
  return {
    async appliedMigrations() {
      const exists = await db.execute<{ exists: boolean }>(
        sql`select to_regclass(${MIGRATIONS}) is not null as "exists"`,
      );
      if (exists.rows[0]?.exists !== true) return 0;
      // Identifiers are constants, never input.
      const result = await db.execute<{ n: number }>(
        sql`select count(*)::int as "n" from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}`,
      );
      return result.rows[0]?.n ?? 0;
    },
    overdueSchedules: (before) => countOverdueSchedules(db, before),
  };
}

/** Production wiring of the checks (route and `pnpm selfhost:check`). */
export function createCheckDeps(env: EnvSource): CheckDeps {
  return {
    env,
    now: () => new Date(),
    expectedMigrations: EXPECTED_MIGRATIONS,
    db: createSetupDb,
    botApi: (token) => new Api(token),
    fetch: (url, init) => fetch(url, init),
  };
}

/** Configures the bot of `env` from APP_URL (the /setup route). */
export async function configureBotFromEnv(env: EnvSource): Promise<void> {
  const bot = getBotEnv(env);
  await configureBot(new Api(bot.TELEGRAM_BOT_TOKEN), {
    appUrl: bot.APP_URL,
    webhookSecret: bot.TELEGRAM_WEBHOOK_SECRET,
  });
}

/** `pnpm selfhost:check --apply`: refuses unless the token belongs to `expectBot`. */
export async function configureExpectedBotFromEnv(
  env: EnvSource,
  expectBot: string,
): Promise<string> {
  const bot = getBotEnv(env);
  return configureExpectedBot(new Api(bot.TELEGRAM_BOT_TOKEN), expectBot, {
    appUrl: bot.APP_URL,
    webhookSecret: bot.TELEGRAM_WEBHOOK_SECRET,
  });
}

let handler: ((req: Request) => Promise<Response>) | undefined;

/** Built on first use (keeps `next build` env-free); the 60s check cache lives with it. */
export function getSetupHandler(): (req: Request) => Promise<Response> {
  handler ??= createSetupApi({
    env: () => process.env,
    checks: () => runChecks(createCheckDeps(process.env)),
    configureBot: () => configureBotFromEnv(process.env),
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
  return handler;
}
