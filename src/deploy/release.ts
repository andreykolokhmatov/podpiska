import { pathToFileURL } from 'node:url';

import { Api } from 'grammy';

import { configureBot } from '@/bot/configure';
import { runMigrations, type MigrationResult } from '@/db/migrate';
import { EnvError, getReleaseEnv, parseEnv, type EnvSource } from '@/lib/env';

export interface ReleaseDeps {
  env: EnvSource;
  migrate: (url: string) => Promise<MigrationResult>;
  configureBot: (input: { token: string; appUrl: string; webhookSecret: string }) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Strips every secret value from a message before it reaches the build log. */
const redact = (message: string, secrets: readonly (string | undefined)[]): string => {
  let out = message;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
};

const passwordOf = (url: string): string | undefined => {
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
};

const isNeonPooled = (url: string): boolean => {
  try {
    return new URL(url).hostname.includes('-pooler');
  } catch {
    return false;
  }
};

const describeError = (error: unknown, secrets: readonly (string | undefined)[]): string => {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  const suffix = typeof code === 'string' || typeof code === 'number' ? ` (code ${code})` : '';
  return `${error.name}: ${redact(error.message, secrets)}${suffix}`;
};

/**
 * Build-time release step of a production deploy: validate env → migrate (fatal) → configure
 * the bot (warning only). Preview and local builds skip it. Env values are never printed.
 * Returns the process exit code.
 */
export async function release(deps: ReleaseDeps): Promise<number> {
  let releaseEnv;
  try {
    releaseEnv = getReleaseEnv(deps.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    deps.error(`release: ${error.message}`);
    return 1;
  }
  if (releaseEnv.VERCEL_ENV !== 'production') {
    deps.log(`release: skipped (VERCEL_ENV=${releaseEnv.VERCEL_ENV ?? 'unset'}, not production)`);
    return 0;
  }
  if (releaseEnv.SKIP_DB_MIGRATE) {
    deps.log('release: skipped (SKIP_DB_MIGRATE)');
    return 0;
  }

  let env;
  try {
    env = parseEnv(deps.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    // EnvError messages list keys and reasons only, never values.
    deps.error(`release: ${error.message}`);
    return 1;
  }

  const dbUrl = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  const dbKey = env.DATABASE_URL_UNPOOLED === undefined ? 'DATABASE_URL' : 'DATABASE_URL_UNPOOLED';
  if (isNeonPooled(dbUrl)) {
    deps.error(
      `release: warning: ${dbKey} points at a Neon pooled host (-pooler); session advisory locks ` +
        'are unreliable through PgBouncer transaction mode. Set DATABASE_URL_UNPOOLED to the direct connection string.',
    );
  }
  const secrets = [
    env.DATABASE_URL,
    env.DATABASE_URL_UNPOOLED,
    passwordOf(env.DATABASE_URL),
    env.DATABASE_URL_UNPOOLED === undefined ? undefined : passwordOf(env.DATABASE_URL_UNPOOLED),
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.CRON_SECRET,
    env.GOOGLE_GENERATIVE_AI_API_KEY,
  ];

  try {
    const result = await deps.migrate(dbUrl);
    deps.log(`migrations: ${result.applied} applied (${result.total} total)`);
  } catch (error) {
    deps.error(`release: migrations failed: ${describeError(error, secrets)}`);
    return 1;
  }

  try {
    await deps.configureBot({
      token: env.TELEGRAM_BOT_TOKEN,
      appUrl: env.APP_URL,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    });
    deps.log('bot configured');
  } catch (error) {
    // The deploy still works for the old webhook; /setup or `pnpm bot:setup` can retry.
    deps.error(`release: warning: bot not configured: ${describeError(error, secrets)}`);
  }
  return 0;
}

const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
};

if (isEntryPoint()) {
  release({
    env: process.env,
    migrate: (url) => runMigrations({ url, warn: (line) => console.error(line) }),
    configureBot: ({ token, appUrl, webhookSecret }) =>
      configureBot(new Api(token), { appUrl, webhookSecret }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`release: ${error instanceof Error ? error.name : 'unknown'} error`);
      process.exitCode = 1;
    },
  );
}
