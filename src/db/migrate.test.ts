import { describe, expect, it, vi } from 'vitest';

import {
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_WAIT_MS,
  MigrationLockTimeoutError,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  runMigrations,
  type MigrationSession,
} from './migrate';

const fakeSession = (opts: {
  before: number | null;
  after: number;
  failMigrate?: boolean;
  busyPolls?: number;
  unlockResult?: boolean;
}) => {
  const log: string[] = [];
  let busy = opts.busyPolls ?? 0;
  let migrated = false;
  const session: MigrationSession = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      log.push(params === undefined ? sql : `${sql} ${JSON.stringify(params)}`);
      if (sql.includes('to_regclass')) {
        return { rows: [{ exists: migrated || opts.before !== null }] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: migrated ? opts.after : opts.before }] };
      if (sql.includes('pg_try_advisory_lock')) {
        if (busy > 0) {
          busy -= 1;
          return { rows: [{ locked: false }] };
        }
        return { rows: [{ locked: true }] };
      }
      if (sql.includes('pg_advisory_unlock'))
        return { rows: [{ unlocked: opts.unlockResult ?? true }] };
      return { rows: [] };
    }),
    migrate: vi.fn(async (folder: string) => {
      log.push(`migrate ${folder}`);
      if (opts.failMigrate === true) throw new Error('relation already exists');
      migrated = true;
    }),
    end: vi.fn(async () => {
      log.push('end');
    }),
  };
  return { session, log };
};

describe('runMigrations', () => {
  it('locks, migrates, unlocks and disconnects in that order', async () => {
    const { session, log } = fakeSession({ before: null, after: 11 });
    const open = vi.fn(async () => session);
    const warn = vi.fn();
    const result = await runMigrations({ url: 'postgres://direct/db', folder: '/m', open, warn });

    expect(warn).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('postgres://direct/db');
    expect(result).toEqual({ applied: 11, total: 11 });
    const lock = log.findIndex((l) => l.startsWith('select pg_try_advisory_lock'));
    const migrate = log.indexOf('migrate /m');
    const unlock = log.findIndex((l) => l.startsWith('select pg_advisory_unlock'));
    expect(lock).toBe(0);
    expect(lock).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(unlock);
    expect(log.at(-1)).toBe('end');
    expect(log[lock]).toContain(String(MIGRATION_LOCK_KEY));
    expect(log[unlock]).toContain(String(MIGRATION_LOCK_KEY));
  });

  it("counts against drizzle-kit's table, so an up-to-date database applies 0", async () => {
    const { session, log } = fakeSession({ before: 11, after: 11 });
    const result = await runMigrations({ url: 'u', folder: '/m', open: async () => session });
    expect(result).toEqual({ applied: 0, total: 11 });
    expect(log.some((l) => l.includes(`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`))).toBe(true);
  });

  it('unlocks and disconnects when a migration fails, and rethrows', async () => {
    const { session, log } = fakeSession({ before: 3, after: 3, failMigrate: true });
    await expect(
      runMigrations({ url: 'u', folder: '/m', open: async () => session }),
    ).rejects.toThrow('relation already exists');
    expect(log.some((l) => l.startsWith('select pg_advisory_unlock'))).toBe(true);
    expect(log.at(-1)).toBe('end');
  });

  it('keeps the migration error when unlocking fails too', async () => {
    const { session, log } = fakeSession({ before: 3, after: 3, failMigrate: true });
    const query = session.query;
    session.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_unlock')) throw new Error('connection lost');
      return query(sql, params);
    });
    await expect(
      runMigrations({ url: 'u', folder: '/m', open: async () => session }),
    ).rejects.toThrow('relation already exists');
    expect(log.at(-1)).toBe('end');
  });

  it('polls the lock while another build holds it, then migrates', async () => {
    const { session, log } = fakeSession({ before: 3, after: 4, busyPolls: 2 });
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const result = await runMigrations({
      url: 'u',
      folder: '/m',
      open: async () => session,
      sleep,
      now: () => clock,
    });
    expect(result).toEqual({ applied: 1, total: 4 });
    expect(log.filter((l) => l.includes('pg_try_advisory_lock'))).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the lock wait deadline without migrating', async () => {
    const { session, log } = fakeSession({ before: 3, after: 3, busyPolls: Infinity });
    let clock = 0;
    const promise = runMigrations({
      url: 'u',
      folder: '/m',
      open: async () => session,
      lockWaitMs: 5_000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    await expect(promise).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    await expect(promise).rejects.toThrow('still held after 5s');
    expect(clock).toBe(5_000);
    expect(log).not.toContain('migrate /m');
    expect(log.some((l) => l.startsWith('select pg_advisory_unlock'))).toBe(false);
    expect(log.at(-1)).toBe('end');
  });

  it('defaults the lock wait to about two minutes', () => {
    expect(MIGRATION_LOCK_WAIT_MS).toBe(120_000);
  });

  it('warns when the unlock reports the lock was not held', async () => {
    const { session } = fakeSession({ before: 3, after: 3, unlockResult: false });
    const warn = vi.fn();
    await runMigrations({
      url: 'postgres://u:pw@h/db',
      folder: '/m',
      open: async () => session,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('advisory unlock returned false');
    expect(warn.mock.calls[0]?.[0]).not.toContain('pw');
  });
});
