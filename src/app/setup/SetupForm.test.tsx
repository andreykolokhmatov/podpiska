import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SetupChecksResponse, SetupCronResponse } from '@/setup/contract';
import SetupPage from './page';
import { CronSettings, INITIAL_STATE, SetupFormView, type SetupState } from './SetupForm';
import { ERROR_TEXT, requestChecks, requestCron, type SetupFetch } from './setup-client';

const noop = () => {};

function view(state: SetupState, token = '123:abc'): string {
  return renderToStaticMarkup(
    <SetupFormView
      token={token}
      state={state}
      onTokenChange={noop}
      onCheck={noop}
      onApply={noop}
      onShowCron={noop}
    />,
  );
}

function mockFetch(status: number, body: unknown) {
  const calls: { input: string; init: RequestInit }[] = [];
  const fetchImpl: SetupFetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetchImpl, calls };
}

const CHECKS: SetupChecksResponse = {
  checkedAt: '2026-11-21T09:05:00.000Z',
  checks: [
    { id: 'db', status: 'ok', title: 'База данных: миграции 11/11' },
    {
      id: 'bot.main_app',
      status: 'fail',
      title: 'Main Mini App не включено',
      hint: 'Откройте @BotFather',
    },
    { id: 'llm', status: 'warn', title: 'Список моделей недоступен через прокси' },
  ],
};

const CRON: SetupCronResponse = {
  url: 'https://example.vercel.app/api/cron/tick',
  method: 'POST',
  header: 'Authorization',
  value: 'Bearer s3cr3t-value',
};

describe('/setup', () => {
  it('renders the heading, the password field and the local alternative', () => {
    const html = renderToStaticMarkup(<SetupPage />);
    expect(html).toContain('Проверка экземпляра');
    expect(html).toContain('нигде не сохраняется');
    expect(html).toMatch(/<label for="[^"]+">Токен бота<\/label>/);
    expect(html).toContain('type="password"');
    expect(html).toContain('Проверить');
    expect(html).toContain('pnpm selfhost:check');
    expect(html).not.toContain('—');
  });

  it('a 401 shows the wrong-token error', async () => {
    const { fetchImpl, calls } = mockFetch(401, { error: 'unauthorized' });

    const res = await requestChecks(fetchImpl, '123:wrong', 'check');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/setup');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      token: '123:wrong',
      action: 'check',
    });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    if (res.ok) return;
    const html = view({ ...INITIAL_STATE, error: res.error });
    expect(html).toContain('role="alert"');
    expect(html).toContain(ERROR_TEXT.unauthorized);
    expect(html).not.toContain('Настроить бота');
  });

  it('maps every error code and a network failure to a text', async () => {
    for (const [status, code] of [
      [400, 'bad_request'],
      [429, 'rate_limited'],
      [500, 'misconfigured'],
      [500, 'internal'],
    ] as const) {
      const { fetchImpl } = mockFetch(status, { error: code });
      expect(await requestChecks(fetchImpl, 't', 'check')).toEqual({ ok: false, error: code });
    }
    const offline: SetupFetch = () => Promise.reject(new TypeError('offline'));
    expect(await requestChecks(offline, 't', 'check')).toEqual({ ok: false, error: 'network' });
    const { fetchImpl } = mockFetch(200, { nope: true });
    expect(await requestChecks(fetchImpl, 't', 'check')).toEqual({
      ok: false,
      error: 'bad_response',
    });
  });

  it('a successful check renders every check with its status', async () => {
    const { fetchImpl } = mockFetch(200, CHECKS);

    const res = await requestChecks(fetchImpl, '123:abc', 'check');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const html = view({ ...INITIAL_STATE, result: res.data });
    expect(html).toContain('Есть ошибки – экземпляр работает не полностью.');
    expect(html).toContain('<li class="su-ok">');
    expect(html).toContain('<li class="su-fail">');
    expect(html).toContain('<li class="su-warn">');
    expect(html).toContain('Готово: ');
    expect(html).toContain('Ошибка: ');
    expect(html).toContain('Внимание: ');
    expect(html).toContain('База данных: миграции 11/11');
    expect(html).toContain('Откройте @BotFather');
    expect(html).toMatch(/Проверено в \d{2}:\d{2}/);
    expect(html).toContain('Настроить бота');
    expect(html).toContain('Показать настройки');
  });

  it('shows the apply error next to «Настроить бота»', () => {
    const html = view({
      ...INITIAL_STATE,
      result: { ...CHECKS, apply: { ok: false, error: 'setWebhook: Bad Request' } },
    });
    expect(html).toContain('Не удалось настроить бота: setWebhook: Bad Request');
  });

  it('cron value stays masked until the toggle', async () => {
    const { fetchImpl, calls } = mockFetch(200, CRON);

    const res = await requestCron(fetchImpl, '123:abc');

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ token: '123:abc', action: 'cron' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const masked = renderToStaticMarkup(<CronSettings cron={res.data} />);
    expect(masked).toContain('value="https://example.vercel.app/api/cron/tick"');
    expect(masked).toMatch(/type="password"[^>]*value="Bearer s3cr3t-value"/);
    expect(masked).not.toMatch(/type="text"[^>]*value="Bearer s3cr3t-value"/);
    expect(masked).toContain('aria-pressed="false"');
    expect(masked).toContain('Показать');
    expect(masked).toContain('Test run');

    const revealed = renderToStaticMarkup(<CronSettings cron={res.data} initialRevealed />);
    expect(revealed).toMatch(/type="text"[^>]*value="Bearer s3cr3t-value"/);
    expect(revealed).toContain('Скрыть');
  });
});
