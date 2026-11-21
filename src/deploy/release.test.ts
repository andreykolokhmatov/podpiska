import { describe, expect, it, vi } from 'vitest';

import { release, type ReleaseDeps } from './release';

const TOKEN = '123456789:AAH-secret_token';
const DB = 'postgresql://user:hunter2pass@ep-x-pooler.eu-central-1.aws.neon.tech/db';
const DB_DIRECT = 'postgresql://user:hunter2pass@direct.example/db';

const prodEnv = {
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'fork.vercel.app',
  DATABASE_URL: DB,
  DATABASE_URL_UNPOOLED: DB_DIRECT,
  TELEGRAM_BOT_TOKEN: TOKEN,
  GOOGLE_GENERATIVE_AI_API_KEY: 'google-key-secret',
  OWNER_TELEGRAM_ID: '42',
};

const setup = (env: Record<string, string | undefined>, overrides: Partial<ReleaseDeps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ReleaseDeps = {
    env,
    migrate: vi.fn(async () => ({ applied: 2, total: 11 })),
    configureBot: vi.fn(async () => undefined),
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    ...overrides,
  };
  return { deps, out, err };
};

const leaks = (lines: string[]) => {
  const text = lines.join('\n');
  return ['hunter2pass', TOKEN, 'google-key-secret', 'secret_token'].filter((s) =>
    text.includes(s),
  );
};

describe('release', () => {
  it.each([
    ['preview', { ...prodEnv, VERCEL_ENV: 'preview' }],
    ['local build', { ...prodEnv, VERCEL_ENV: undefined }],
    ['SKIP_DB_MIGRATE', { ...prodEnv, SKIP_DB_MIGRATE: '1' }],
  ])('does nothing on %s', async (_, env) => {
    const { deps, out } = setup(env);
    expect(await release(deps)).toBe(0);
    expect(deps.migrate).not.toHaveBeenCalled();
    expect(deps.configureBot).not.toHaveBeenCalled();
    expect(out.join()).toContain('skipped');
  });

  it('migrates on the unpooled URL, then configures the bot with derived values', async () => {
    const { deps, out, err } = setup(prodEnv);
    expect(await release(deps)).toBe(0);
    expect(deps.migrate).toHaveBeenCalledWith(DB_DIRECT);
    expect(deps.configureBot).toHaveBeenCalledWith({
      token: TOKEN,
      appUrl: 'https://fork.vercel.app',
      webhookSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(out).toEqual(['migrations: 2 applied (11 total)', 'bot configured']);
    expect(err).toEqual([]);
  });

  it('falls back to DATABASE_URL without an unpooled URL, warning about the pooler', async () => {
    const { deps, err } = setup({ ...prodEnv, DATABASE_URL_UNPOOLED: undefined });
    expect(await release(deps)).toBe(0);
    expect(deps.migrate).toHaveBeenCalledWith(DB);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('warning: DATABASE_URL points at a Neon pooled host');
    expect(err[0]).toContain('DATABASE_URL_UNPOOLED');
    expect(err[0]).not.toContain('ep-x-pooler');
    expect(leaks(err)).toEqual([]);
  });

  it('warns when even DATABASE_URL_UNPOOLED is a pooled host', async () => {
    const { deps, err } = setup({ ...prodEnv, DATABASE_URL_UNPOOLED: DB });
    expect(await release(deps)).toBe(0);
    expect(err.join()).toContain('warning: DATABASE_URL_UNPOOLED points at a Neon pooled host');
  });

  it('does not warn for a non-pooled fallback URL', async () => {
    const { deps, err } = setup({
      ...prodEnv,
      DATABASE_URL: DB_DIRECT,
      DATABASE_URL_UNPOOLED: undefined,
    });
    expect(await release(deps)).toBe(0);
    expect(err).toEqual([]);
  });

  it('fails on an invalid env, naming keys only', async () => {
    const { deps, err } = setup({
      ...prodEnv,
      OWNER_TELEGRAM_ID: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: '',
    });
    expect(await release(deps)).not.toBe(0);
    expect(deps.migrate).not.toHaveBeenCalled();
    const text = err.join('\n');
    expect(text).toContain('OWNER_TELEGRAM_ID');
    expect(text).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(leaks(err)).toEqual([]);
  });

  it('fails the build when a migration fails, without leaking the URL', async () => {
    const { deps, err } = setup(prodEnv, {
      migrate: vi.fn(async () => {
        throw Object.assign(new Error(`connect failed for ${DB_DIRECT}`), { code: '28P01' });
      }),
    });
    expect(await release(deps)).not.toBe(0);
    expect(deps.configureBot).not.toHaveBeenCalled();
    expect(err.join()).toContain('migrations failed');
    expect(err.join()).toContain('28P01');
    expect(leaks(err)).toEqual([]);
  });

  it('only warns when the bot cannot be configured', async () => {
    const { deps, out, err } = setup(prodEnv, {
      configureBot: vi.fn(async () => {
        throw new Error(`401 Unauthorized for ${TOKEN}`);
      }),
    });
    expect(await release(deps)).toBe(0);
    expect(out).toEqual(['migrations: 2 applied (11 total)']);
    expect(err.join()).toContain('warning: bot not configured');
    expect(leaks(err)).toEqual([]);
  });
});
