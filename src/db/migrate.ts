import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/** drizzle-kit's defaults (drizzle.config.ts overrides neither), so both tools share history. */
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';
/** Session advisory lock key: two parallel production builds must not migrate at once. */
export const MIGRATION_LOCK_KEY = 727_190_001;

export const DEFAULT_MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle');

/** One dedicated connection: an advisory lock belongs to the session that took it. */
export interface MigrationSession {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Applies the pending migrations from `folder` (drizzle-orm migrator). */
  migrate(folder: string): Promise<void>;
  end(): Promise<void>;
}

export type OpenMigrationSession = (url: string) => Promise<MigrationSession>;

export const openPgSession: OpenMigrationSession = async (url) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  const db = drizzle(client);
  return {
    query: async (sql, params) => client.query<Record<string, unknown>>(sql, params),
    migrate: (folder) =>
      migrate(db, {
        migrationsFolder: folder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      }),
    end: () => client.end(),
  };
};

export interface MigrationResult {
  /** Migrations applied by this run. */
  applied: number;
  /** Migrations recorded in the database afterwards. */
  total: number;
}

const appliedCount = async (session: MigrationSession): Promise<number> => {
  const exists = await session.query('select to_regclass($1) is not null as "exists"', [
    `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
  ]);
  if (exists.rows[0]?.exists !== true) return 0;
  const result = await session.query(
    `select count(*)::int as "n" from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  );
  const n = result.rows[0]?.n;
  return typeof n === 'number' ? n : 0;
};

/** A parallel build normally finishes well within this; past it something is stuck. */
export const MIGRATION_LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 1_000;

export class MigrationLockTimeoutError extends Error {
  override name = 'MigrationLockTimeoutError';
}

export interface RunMigrationsOptions {
  /** DATABASE_URL_UNPOOLED ?? DATABASE_URL: advisory locks need a direct (unpooled) session. */
  url: string;
  folder?: string;
  open?: OpenMigrationSession;
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls pg_try_advisory_lock instead of a blocking pg_advisory_lock + lock_timeout: no
 * session-level SET is needed, so the bound holds even behind a transaction-mode pooler.
 */
async function acquireLock(
  session: MigrationSession,
  options: Required<Pick<RunMigrationsOptions, 'lockWaitMs' | 'sleep' | 'now'>>,
): Promise<void> {
  const deadline = options.now() + options.lockWaitMs;
  for (;;) {
    const result = await session.query('select pg_try_advisory_lock($1) as "locked"', [
      MIGRATION_LOCK_KEY,
    ]);
    if (result.rows[0]?.locked === true) return;
    const left = deadline - options.now();
    if (left <= 0) {
      throw new MigrationLockTimeoutError(
        `migration lock ${MIGRATION_LOCK_KEY} still held after ${Math.round(options.lockWaitMs / 1000)}s; ` +
          'another deploy may be migrating or a stale session holds it (check pg_locks)',
      );
    }
    await options.sleep(Math.min(LOCK_POLL_MS, left));
  }
}

/** Applies pending migrations under a session advisory lock (bounded wait); unlocks and disconnects in finally. */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const session = await (options.open ?? openPgSession)(options.url);
  try {
    await acquireLock(session, {
      lockWaitMs: options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    });
    try {
      const before = await appliedCount(session);
      await session.migrate(options.folder ?? DEFAULT_MIGRATIONS_FOLDER);
      const total = await appliedCount(session);
      return { applied: total - before, total };
    } finally {
      const warn = options.warn ?? ((line: string) => console.warn(line));
      // A failed or false unlock is not fatal: ending the session below releases the lock.
      try {
        const unlocked = await session.query('select pg_advisory_unlock($1) as "unlocked"', [
          MIGRATION_LOCK_KEY,
        ]);
        if (unlocked.rows[0]?.unlocked !== true) {
          warn(
            `migrations: warning: advisory unlock returned false (lock ${MIGRATION_LOCK_KEY} not held by this session; pooled connection?)`,
          );
        }
      } catch (error) {
        warn(
          `migrations: warning: advisory unlock failed (${error instanceof Error ? error.name : 'unknown error'})`,
        );
      }
    }
  } finally {
    await session.end();
  }
}
