import { describe, expect, it, vi } from 'vitest';

import { CHECKS_TTL_MS, createSetupApi, FAILED_TOKENS_PER_MINUTE, type SetupApiDeps } from './api';
import type { Check } from './contract';

const TOKEN = '123456789:AAH-secret_token';
const CRON = 'c'.repeat(40);
const env = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  APP_URL: 'https://fork.vercel.app',
  CRON_SECRET: CRON,
  DATABASE_URL: 'postgresql://user:hunter2pass@db.example/db',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google-key-secret',
};
const CHECKS: Check[] = [{ id: 'env', status: 'ok', title: 'Переменные окружения заданы' }];

const setup = (overrides: Partial<SetupApiDeps> = {}) => {
  let clock = 1_000_000;
  const log = vi.fn<(line: string) => void>();
  const deps: SetupApiDeps = {
    env: () => env,
    checks: vi.fn(async () => CHECKS),
    configureBot: vi.fn(async () => undefined),
    now: () => clock,
    log,
    ...overrides,
  };
  return {
    handle: createSetupApi(deps),
    deps,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const post = (body: unknown, ip = '1.2.3.4') =>
  new Request('https://fork.vercel.app/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/setup', () => {
  it('401 without details for a wrong or missing token', async () => {
    const { handle, deps } = setup();
    for (const body of [
      { token: '1:wrong', action: 'check' },
      { token: '', action: 'cron' },
    ]) {
      const res = await handle(post(body));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(deps.checks).not.toHaveBeenCalled();
  });

  it('400 on a malformed body', async () => {
    const { handle } = setup();
    expect((await handle(post('not json'))).status).toBe(400);
    expect((await handle(post({ token: TOKEN, action: 'drop' }))).status).toBe(400);
  });

  it('200 check returns checks and no secrets', async () => {
    const { handle, log } = setup();
    const res = await handle(post({ token: ` ${TOKEN} `, action: 'check' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ checks: CHECKS });
    for (const secret of [TOKEN, CRON, 'hunter2pass', 'google-key-secret']) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it('caches checks for 60s; apply bypasses and refreshes', async () => {
    const { handle, deps, advance } = setup();
    const check = () => handle(post({ token: TOKEN, action: 'check' }));
    await check();
    await check();
    expect(deps.checks).toHaveBeenCalledTimes(1);

    const applied = await handle(post({ token: TOKEN, action: 'apply' }));
    expect(await applied.json()).toMatchObject({ checks: CHECKS, apply: { ok: true } });
    expect(deps.configureBot).toHaveBeenCalledTimes(1);
    expect(deps.checks).toHaveBeenCalledTimes(2);

    await check();
    expect(deps.checks).toHaveBeenCalledTimes(2);
    advance(CHECKS_TTL_MS);
    await check();
    expect(deps.checks).toHaveBeenCalledTimes(3);
  });

  it('apply reports a configure failure without the token', async () => {
    const { handle } = setup({
      configureBot: vi.fn(async () => {
        throw new Error(`setWebhook failed for ${TOKEN}`);
      }),
    });
    const res = await handle(post({ token: TOKEN, action: 'apply' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({ apply: { ok: false }, checks: CHECKS });
  });

  it('cron returns the secret only after a valid token', async () => {
    const { handle } = setup();
    const denied = await handle(post({ token: '1:nope', action: 'cron' }));
    expect(await denied.text()).not.toContain(CRON);

    const res = await handle(post({ token: TOKEN, action: 'cron' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      url: 'https://fork.vercel.app/api/cron/tick',
      method: 'POST',
      header: 'Authorization',
      value: `Bearer ${CRON}`,
    });
  });

  it('cron derives the secret when CRON_SECRET is unset', async () => {
    const { handle } = setup({ env: () => ({ ...env, CRON_SECRET: undefined }) });
    const body = (await (await handle(post({ token: TOKEN, action: 'cron' }))).json()) as {
      value: string;
    };
    expect(body.value).toMatch(/^Bearer [0-9a-f]{64}$/);
  });

  it('429 after repeated wrong tokens from one address, for a minute', async () => {
    const { handle, advance } = setup();
    for (let i = 0; i < FAILED_TOKENS_PER_MINUTE; i += 1) {
      expect((await handle(post({ token: `1:x${i}`, action: 'check' }))).status).toBe(401);
    }
    const limited = await handle(post({ token: TOKEN, action: 'check' }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    // Another address is unaffected.
    expect((await handle(post({ token: TOKEN, action: 'check' }, '5.6.7.8'))).status).toBe(200);
    advance(60_000);
    expect((await handle(post({ token: TOKEN, action: 'check' }))).status).toBe(200);
  });

  it('401 when the deploy has no bot token to compare against', async () => {
    const { handle, deps } = setup({ env: () => ({ ...env, TELEGRAM_BOT_TOKEN: '' }) });
    for (const token of ['', TOKEN]) {
      const res = await handle(post({ token, action: 'check' }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(deps.checks).not.toHaveBeenCalled();
  });

  it('409 not_production for apply on a preview deploy', async () => {
    for (const vercelEnv of ['preview', 'development']) {
      const { handle, deps } = setup({ env: () => ({ ...env, VERCEL_ENV: vercelEnv }) });
      const res = await handle(post({ token: TOKEN, action: 'apply' }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'not_production' });
      expect(deps.configureBot).not.toHaveBeenCalled();
      // Read-only checks still work there.
      expect((await handle(post({ token: TOKEN, action: 'check' }))).status).toBe(200);
    }
    const prod = setup({ env: () => ({ ...env, VERCEL_ENV: 'production' }) });
    expect((await prod.handle(post({ token: TOKEN, action: 'apply' }))).status).toBe(200);
    expect(prod.deps.configureBot).toHaveBeenCalledTimes(1);
  });
});
