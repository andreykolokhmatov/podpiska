import { describe, expect, it, vi } from 'vitest';

import { BotMismatchError } from '@/bot/configure';

import type { Check } from './contract';
import { doctor, formatChecks, parseDoctorArgs, type DoctorDeps } from './doctor';

const TOKEN = '123456789:AAH-secret_token';
const CRON = 'c'.repeat(40);
const env = { TELEGRAM_BOT_TOKEN: TOKEN, APP_URL: 'https://fork.vercel.app', CRON_SECRET: CRON };
const ok: Check = { id: 'env', status: 'ok', title: 'Переменные окружения заданы' };
const failing: Check = {
  id: 'bot.main_app',
  status: 'fail',
  title: 'Main Mini App',
  hint: 'BotFather',
};

const setup = (checks: Check[] = [ok], overrides: Partial<DoctorDeps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DoctorDeps = {
    env,
    checks: vi.fn(async () => checks),
    configureBot: vi.fn<(expectBot: string) => Promise<string>>(async () => 'my_bot'),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };
  return { deps, out, err };
};

describe('parseDoctorArgs', () => {
  it('parses flags', () => {
    expect(parseDoctorArgs([])).toEqual({ apply: false, expectBot: '', showCron: false });
    expect(parseDoctorArgs(['--apply', '--expect-bot', '@My_Bot', '--show-cron'])).toEqual({
      apply: true,
      expectBot: 'my_bot',
      showCron: true,
    });
  });

  it('rejects unknown flags and positionals', () => {
    expect(() => parseDoctorArgs(['--force'])).toThrow(/Usage/);
    expect(() => parseDoctorArgs(['init'])).toThrow(/Usage/);
    expect(() => parseDoctorArgs(['--apply'])).toThrow(/--expect-bot/);
  });
});

describe('doctor', () => {
  it('exits 0 when nothing fails and prints the table', async () => {
    const { deps, out } = setup([ok, { ...ok, id: 'llm', status: 'warn', title: 'w' }]);
    expect(await doctor([], deps)).toBe(0);
    expect(out.join('\n')).toContain('[ OK ] Переменные окружения заданы');
    expect(out.join('\n')).toContain('ok: 1, warn: 1, fail: 0');
    expect(deps.configureBot).not.toHaveBeenCalled();
  });

  it('exits 1 when a check fails', async () => {
    const { deps } = setup([ok, failing]);
    expect(await doctor([], deps)).toBe(1);
  });

  it('exits 2 on bad arguments without running checks', async () => {
    const { deps, err } = setup();
    expect(await doctor(['--nope'], deps)).toBe(2);
    expect(err[0]).toContain('Usage');
    expect(deps.checks).not.toHaveBeenCalled();
  });

  it('--apply configures the bot before checking', async () => {
    const order: string[] = [];
    const { deps } = setup([ok], {
      configureBot: vi.fn(async (expect: string) => {
        order.push(`configure ${expect}`);
        return 'my_bot';
      }),
      checks: vi.fn(async () => {
        order.push('checks');
        return [ok];
      }),
    });
    expect(await doctor(['--apply', '--expect-bot', 'my_bot'], deps)).toBe(0);
    expect(order).toEqual(['configure my_bot', 'checks']);
  });

  it('--apply failure exits 1 and redacts the token', async () => {
    const { deps, err } = setup([ok], {
      configureBot: vi.fn(async () => {
        throw new Error(`bad ${TOKEN}`);
      }),
    });
    expect(await doctor(['--apply', '--expect-bot', 'my_bot'], deps)).toBe(1);
    expect(err.join('\n')).not.toContain(TOKEN);
  });

  it('--apply without --expect-bot exits 2 and changes nothing', async () => {
    const { deps } = setup();
    expect(await doctor(['--apply'], deps)).toBe(2);
    expect(deps.configureBot).not.toHaveBeenCalled();
    expect(deps.checks).not.toHaveBeenCalled();
  });

  it('--apply for another bot refuses with exit 2 before any check', async () => {
    const { deps, err } = setup([ok], {
      configureBot: vi.fn(async () => {
        throw new BotMismatchError(
          'token belongs to @other_bot, expected @my_bot; nothing changed',
        );
      }),
    });
    expect(await doctor(['--apply', '--expect-bot', 'my_bot'], deps)).toBe(2);
    expect(err.join('\n')).toContain('@other_bot');
    expect(deps.checks).not.toHaveBeenCalled();
  });

  it('prints CRON_SECRET only with --show-cron', async () => {
    const plain = setup();
    await doctor([], plain.deps);
    expect(plain.out.join('\n')).not.toContain(CRON);

    const shown = setup();
    expect(await doctor(['--show-cron'], shown.deps)).toBe(0);
    const text = shown.out.join('\n');
    expect(text).toContain('https://fork.vercel.app/api/cron/tick');
    expect(text).toContain('POST');
    expect(text).toContain(`Authorization = Bearer ${CRON}`);
  });

  it('formats hints on their own line', () => {
    expect(formatChecks([failing])).toContain('[FAIL] Main Mini App\n       BotFather');
  });
});
