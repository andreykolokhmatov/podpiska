import { describe, expect, it, vi } from 'vitest';

import type { StatusApi } from '@/bot/configure';

import { GOOGLE_API_BASE, runChecks, type CheckDeps, type SetupDb } from './checks';
import type { Check } from './contract';

const TOKEN = '123456789:AAH-secret_token';
const KEY = 'google-key-secret';
const APP = 'https://fork.vercel.app';
const DB_PASSWORD = 'hunter2pass';
const now = new Date('2026-11-21T12:00:00Z');

const goodEnv = {
  DATABASE_URL: `postgresql://user:${DB_PASSWORD}@db.example/db`,
  VERCEL_PROJECT_PRODUCTION_URL: 'fork.vercel.app',
  TELEGRAM_BOT_TOKEN: TOKEN,
  GOOGLE_GENERATIVE_AI_API_KEY: KEY,
  OWNER_TELEGRAM_ID: '42',
};

const statusApi = (overrides: Record<string, unknown> = {}): StatusApi =>
  ({
    getMe: vi.fn(async () => ({ username: 'my_bot', has_main_web_app: true })),
    getWebhookInfo: vi.fn(async () => ({ url: `${APP}/api/bot`, pending_update_count: 0 })),
    getChatMenuButton: vi.fn(async () => ({ type: 'web_app', text: 'x', web_app: { url: APP } })),
    ...overrides,
  }) as unknown as StatusApi;

const modelsResponse = (ids: string[], status = 200) =>
  new Response(JSON.stringify({ models: ids.map((id) => ({ name: `models/${id}` })) }), {
    status,
  });

const setup = (overrides: Partial<CheckDeps> = {}, db: Partial<SetupDb> = {}) => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    modelsResponse(['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'other']),
  );
  const deps: CheckDeps = {
    env: goodEnv,
    now: () => now,
    expectedMigrations: 11,
    db: () => ({
      appliedMigrations: async () => 11,
      overdueSchedules: async () => 0,
      ...db,
    }),
    botApi: () => statusApi(),
    fetch,
    ...overrides,
  };
  return { deps, fetch };
};

const byId = (checks: Check[], id: string) => checks.find((check) => check.id === id);

describe('runChecks', () => {
  it('reports a healthy deploy as all ok', async () => {
    const { deps } = setup();
    const checks = await runChecks(deps);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['env', 'ok'],
      ['env.access', 'ok'],
      ['db', 'ok'],
      ['db.migrations', 'ok'],
      ['bot', 'ok'],
      ['bot.webhook', 'ok'],
      ['bot.menu', 'ok'],
      ['bot.main_app', 'ok'],
      ['llm', 'ok'],
      ['schedule', 'ok'],
    ]);
    expect(byId(checks, 'env')?.hint).toContain('APP_URL – из домена Vercel');
    expect(byId(checks, 'env')?.hint).toContain('CRON_SECRET – вычислен из токена бота');
    expect(byId(checks, 'db.migrations')?.title).toContain('11/11');
  });

  it('never puts secret values into titles or hints', async () => {
    const { deps } = setup({
      env: { ...goodEnv, CRON_SECRET: 'c'.repeat(40), TELEGRAM_WEBHOOK_SECRET: 'whsecret' },
    });
    const text = JSON.stringify(await runChecks(deps));
    for (const secret of [TOKEN, KEY, DB_PASSWORD, 'c'.repeat(40), 'whsecret']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('CRON_SECRET – задан явно');
  });

  it('checks the LLM key with one GET of the model list, never a generation', async () => {
    const { deps, fetch } = setup();
    await runChecks(deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url.startsWith(`${GOOGLE_API_BASE}/models`)).toBe(true);
    expect(url).not.toMatch(/generate/i);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
  });

  it('uses LLM_BASE_URL for the model list', async () => {
    const { deps, fetch } = setup({
      env: { ...goodEnv, LLM_BASE_URL: 'https://proxy.example/google/v1beta/' },
    });
    await runChecks(deps);
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://proxy.example/google/v1beta/models?pageSize=1000',
    );
  });

  it('fails on a rejected LLM key', async () => {
    for (const status of [400, 401, 403]) {
      const { deps } = setup({ fetch: vi.fn(async () => new Response('{}', { status })) });
      const llm = byId(await runChecks(deps), 'llm');
      expect(llm?.status).toBe('fail');
      expect(llm?.title).toBe('Ключ LLM не принят');
    }
  });

  it('only warns when a proxy cannot list models', async () => {
    for (const status of [404, 405]) {
      const { deps } = setup({
        env: { ...goodEnv, LLM_BASE_URL: 'https://proxy.example/google/v1beta' },
        fetch: vi.fn(async () => new Response('', { status })),
      });
      const llm = byId(await runChecks(deps), 'llm');
      expect(llm?.status).toBe('warn');
      expect(llm?.title).toBe('Не удалось проверить ключ LLM через прокси');
    }
  });

  it('fails when a configured model is missing from the list', async () => {
    const { deps } = setup({ fetch: vi.fn(async () => modelsResponse(['gemini-3.5-flash-lite'])) });
    const llm = byId(await runChecks(deps), 'llm');
    expect(llm?.status).toBe('fail');
    expect(llm?.title).toContain('gemini-3.5-flash');
    expect(llm?.hint).toContain('LLM_MODEL_SMART');
  });

  it('fails without Main Mini App and on a foreign webhook', async () => {
    const { deps } = setup({
      botApi: () =>
        statusApi({
          getMe: vi.fn(async () => ({ username: 'my_bot', has_main_web_app: false })),
          getWebhookInfo: vi.fn(async () => ({
            url: 'https://old.example/api/bot',
            pending_update_count: 3,
          })),
        }),
    });
    const checks = await runChecks(deps);
    expect(byId(checks, 'bot.main_app')).toMatchObject({
      status: 'fail',
      title: 'Не включена Main Mini App в BotFather – не будут работать ссылки “Поделиться”',
    });
    expect(byId(checks, 'bot.webhook')?.status).toBe('fail');
  });

  it('warns about the last webhook error', async () => {
    const { deps } = setup({
      botApi: () =>
        statusApi({
          getWebhookInfo: vi.fn(async () => ({
            url: `${APP}/api/bot`,
            pending_update_count: 1,
            last_error_date: 1_795_000_000,
            last_error_message: 'Wrong response from the webhook: 500 Internal Server Error',
          })),
        }),
    });
    const webhook = byId(await runChecks(deps), 'bot.webhook');
    expect(webhook?.status).toBe('warn');
    expect(webhook?.title).toContain('500 Internal Server Error');
  });

  it('fails on a token Telegram rejects', async () => {
    const { deps } = setup({
      botApi: () =>
        statusApi({
          getMe: vi.fn(async () => {
            throw Object.assign(new Error('Unauthorized'), { error_code: 401 });
          }),
        }),
    });
    expect(byId(await runChecks(deps), 'bot')).toMatchObject({
      status: 'fail',
      title: 'Telegram не принял токен бота',
    });
  });

  it('reports pending migrations and an unreachable database', async () => {
    const pending = await runChecks(setup({}, { appliedMigrations: async () => 9 }).deps);
    expect(byId(pending, 'db.migrations')).toMatchObject({ status: 'fail' });
    expect(byId(pending, 'db.migrations')?.title).toContain('9 из 11');

    const down = await runChecks(
      setup(
        {},
        {
          appliedMigrations: async () => {
            throw Object.assign(new Error(`password ${DB_PASSWORD} rejected`), { code: '28P01' });
          },
        },
      ).deps,
    );
    expect(byId(down, 'db')?.status).toBe('fail');
    expect(JSON.stringify(down)).not.toContain(DB_PASSWORD);
    expect(byId(down, 'db')?.hint).toContain('28P01');
  });

  it('warns when scheduled issues are overdue by more than 2h', async () => {
    const overdue = vi.fn<(before: Date) => Promise<number>>(async () => 2);
    const checks = await runChecks(setup({}, { overdueSchedules: overdue }).deps);
    expect(overdue).toHaveBeenCalledWith(new Date('2026-11-21T10:00:00Z'));
    expect(byId(checks, 'schedule')).toMatchObject({
      status: 'warn',
      title: 'Будильник не срабатывает – настройте cron-job.org',
    });
  });

  it('reports bad env without calling Telegram or the LLM', async () => {
    const botApi = vi.fn(() => statusApi());
    const { deps, fetch } = setup({
      env: { DATABASE_URL: goodEnv.DATABASE_URL },
      botApi,
    });
    const checks = await runChecks(deps);
    expect(byId(checks, 'env')?.status).toBe('fail');
    expect(byId(checks, 'env')?.hint).toContain('TELEGRAM_BOT_TOKEN');
    expect(byId(checks, 'env.access')?.status).toBe('fail');
    expect(byId(checks, 'llm')?.status).toBe('fail');
    expect(botApi).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('times out a hanging call', async () => {
    const { deps } = setup(
      { timeoutMs: 20 },
      { appliedMigrations: () => new Promise<number>(() => undefined) },
    );
    expect(byId(await runChecks(deps), 'db')?.status).toBe('fail');
  });

  it('describes a private instance with an allowlist', async () => {
    const { deps } = setup({ env: { ...goodEnv, ALLOWED_TELEGRAM_IDS: '7, 8' } });
    expect(byId(await runChecks(deps), 'env.access')?.title).toContain('ещё 2');
    const open = setup({ env: { ...goodEnv, PUBLIC: '1', OWNER_TELEGRAM_ID: '' } });
    expect(byId(await runChecks(open.deps), 'env.access')?.title).toContain('PUBLIC=1');
  });
});
