import { parseArgs } from 'node:util';

import { BotMismatchError, normalizeBotUsername } from '@/bot/configure';
import { isEntryPoint } from '@/lib/entry';
import { EnvError, getCronEnv, type EnvSource } from '@/lib/env';

import type { Check } from './contract';

export const USAGE =
  'Usage: pnpm selfhost:check [--apply --expect-bot <bot_username>] [--show-cron]';

export interface DoctorOptions {
  /** Configure the bot (webhook, commands, menu button) before checking. */
  apply: boolean;
  /** Required with --apply: the bot the token must belong to (without @, lowercased). */
  expectBot: string;
  /** Print the cron-job.org job settings, CRON_SECRET included. */
  showCron: boolean;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function parseDoctorArgs(argv: readonly string[]): DoctorOptions {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        apply: { type: 'boolean', default: false },
        'expect-bot': { type: 'string' },
        'show-cron': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const expectBot = normalizeBotUsername(values['expect-bot']);
    if (values.apply && expectBot === '') throw new UsageError(USAGE);
    return { apply: values.apply, expectBot, showCron: values['show-cron'] };
  } catch {
    throw new UsageError(USAGE);
  }
}

const MARK: Record<Check['status'], string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };

/** Plain text, no ANSI colors: reads the same in cmd.exe, PowerShell and any terminal. */
export function formatChecks(checks: readonly Check[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${MARK[check.status]} ${check.title}`);
    if (check.hint !== undefined) lines.push(`       ${check.hint}`);
  }
  const count = (status: Check['status']) => checks.filter((c) => c.status === status).length;
  lines.push('');
  lines.push(`ok: ${count('ok')}, warn: ${count('warn')}, fail: ${count('fail')}`);
  return lines.join('\n');
}

export interface DoctorDeps {
  env: EnvSource;
  checks: () => Promise<Check[]>;
  /** configureExpectedBot: getMe guard first; returns the bot's username. */
  configureBot: (expectBot: string) => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
}

const errorText = (error: unknown, secret: string | undefined): string => {
  if (!(error instanceof Error)) return 'unknown error';
  const message =
    secret !== undefined && secret.length >= 4
      ? error.message.split(secret).join('[redacted]')
      : error.message;
  return `${error.name}: ${message}`;
};

/** `pnpm selfhost:check`: the /setup checklist over the local .env. Returns the exit code. */
export async function doctor(argv: readonly string[], deps: DoctorDeps): Promise<number> {
  let options: DoctorOptions;
  try {
    options = parseDoctorArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.err(error.message);
    return 2;
  }

  let failed = false;
  const token = deps.env.TELEGRAM_BOT_TOKEN?.trim();

  if (options.apply) {
    try {
      const username = await deps.configureBot(options.expectBot);
      deps.out(`Бот @${username} настроен: webhook, команда /start, кнопка меню.\n`);
    } catch (error) {
      if (error instanceof BotMismatchError) {
        deps.err(`${error.message}\n${USAGE}`);
        return 2;
      }
      failed = true;
      deps.err(`Не удалось настроить бота – ${errorText(error, token)}\n`);
    }
  }

  const checks = await deps.checks();
  deps.out(formatChecks(checks));
  if (checks.some((check) => check.status === 'fail')) failed = true;

  if (options.showCron) {
    try {
      const env = getCronEnv(deps.env);
      deps.out(
        [
          '',
          'Задание cron-job.org (Create cronjob):',
          `  URL:        ${env.APP_URL}/api/cron/tick`,
          '  Расписание: каждый час, в 1-ю минуту',
          '  Advanced → Request method: POST',
          `  Advanced → Headers: Authorization = Bearer ${env.CRON_SECRET}`,
        ].join('\n'),
      );
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      failed = true;
      deps.err(`\n--show-cron: ${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  await import('dotenv/config');
  const { closeDb } = await import('@/db');
  const { configureExpectedBotFromEnv, createCheckDeps } = await import('./index');
  const { runChecks } = await import('./checks');
  try {
    return await doctor(process.argv.slice(2), {
      env: process.env,
      checks: () => runChecks(createCheckDeps(process.env)),
      configureBot: (expectBot) => configureExpectedBotFromEnv(process.env, expectBot),
      out: (text) => console.log(text),
      err: (text) => console.error(text),
    });
  } finally {
    await closeDb();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`doctor: ${error instanceof Error ? error.name : 'unknown'} error`);
      process.exitCode = 1;
    },
  );
}
