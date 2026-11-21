import { botStatus, type BotStatus, type StatusApi } from '@/bot/configure';
import {
  EnvError,
  getAccessPolicy,
  getBotEnv,
  getCronEnv,
  getDatabaseUrl,
  getLlmEnv,
  parseEnv,
  type EnvSource,
} from '@/lib/env';

import type { Check, CheckId } from './contract';

/** Read-only database probes; implementations must not write. */
export interface SetupDb {
  /** Rows in drizzle.__drizzle_migrations (0 when the table does not exist yet). */
  appliedMigrations(): Promise<number>;
  /** Users whose scheduled slot is older than `before` though a run may start. */
  overdueSchedules(before: Date): Promise<number>;
}

export interface CheckDeps {
  env: EnvSource;
  now: () => Date;
  /** Entries in drizzle/meta/_journal.json: what this code expects to be applied. */
  expectedMigrations: number;
  /** Called only when DATABASE_URL is valid. */
  db: () => SetupDb;
  /** Called only when the bot env is valid. */
  botApi: (token: string) => StatusApi;
  /** Used for exactly one GET {base}/models; never a generation request. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Per external call; default 10s. */
  timeoutMs?: number;
}

export const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** A slot this late was missed by more than one hourly tick. */
export const OVERDUE_MS = 2 * 3_600_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const check = (id: CheckId, status: Check['status'], title: string, hint?: string): Check =>
  hint === undefined ? { id, status, title } : { id, status, title, hint };

const ENV_FIRST = 'Сначала исправьте переменные окружения (пункт выше)';

class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Error name and code only: messages may carry hosts, users or URLs with secrets. */
const errorTag = (error: unknown): string => {
  if (error instanceof TimeoutError) return 'нет ответа за отведённое время';
  if (!(error instanceof Error)) return 'неизвестная ошибка';
  const shape = error as { code?: unknown; errors?: unknown; cause?: unknown };
  // pg reports a refused connection as an AggregateError of per-address errors.
  const nested = Array.isArray(shape.errors) ? (shape.errors[0] as unknown) : shape.cause;
  const code = shape.code ?? (nested as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' || typeof code === 'number'
    ? `${error.name}, код ${code}`
    : error.name;
};

/** `KEY – reason` pairs from an EnvError, which lists keys and reasons only (never values). */
const envProblems = (error: EnvError): string[] =>
  error.message
    .split('\n')
    .map((line) => /^\s+- ([^:]+): (.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]} – ${match[2]}`);

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

function envChecks(env: EnvSource): Check[] {
  const out: Check[] = [];
  try {
    parseEnv(env);
    const notes = [
      isSet(env.APP_URL) ? 'APP_URL – задан явно' : 'APP_URL – из домена Vercel',
      isSet(env.TELEGRAM_WEBHOOK_SECRET)
        ? 'TELEGRAM_WEBHOOK_SECRET – задан явно'
        : 'TELEGRAM_WEBHOOK_SECRET – вычислен из токена бота',
      isSet(env.CRON_SECRET) ? 'CRON_SECRET – задан явно' : 'CRON_SECRET – вычислен из токена бота',
    ];
    out.push(check('env', 'ok', 'Переменные окружения заданы', notes.join('; ')));
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    const problems = envProblems(error);
    out.push(
      check(
        'env',
        'fail',
        'Не хватает переменных окружения или они неверны',
        `${problems.join('; ')}. Vercel → Settings → Environment Variables, затем Redeploy`,
      ),
    );
  }

  try {
    const policy = getAccessPolicy(env);
    if (policy.public) {
      out.push(check('env.access', 'ok', 'Бот открыт для всех (PUBLIC=1)'));
    } else {
      const others = policy.allowed.size - 1;
      out.push(
        check(
          'env.access',
          'ok',
          others > 0
            ? `Частный экземпляр: владелец и ещё ${others} из ALLOWED_TELEGRAM_IDS`
            : 'Частный экземпляр: только владелец',
          'Добавить людей – ALLOWED_TELEGRAM_IDS через запятую; открыть всем – PUBLIC=1',
        ),
      );
    }
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    out.push(
      check(
        'env.access',
        'fail',
        'Не задан владелец частного экземпляра',
        'OWNER_TELEGRAM_ID – ваш числовой id в Telegram (узнать у @userinfobot) или PUBLIC=1, чтобы открыть бота всем',
      ),
    );
  }
  return out;
}

const MIGRATE_HINT =
  'Миграции применяются при production-деплое: сделайте Redeploy в Vercel (или локально pnpm db:migrate)';

async function dbChecks(deps: CheckDeps, timeoutMs: number): Promise<Check[]> {
  try {
    getDatabaseUrl({}, deps.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return [
      check(
        'db',
        'fail',
        'DATABASE_URL не задан или неверен',
        'Подключите Neon в Vercel → Storage',
      ),
    ];
  }
  let applied: number;
  try {
    applied = await withTimeout(deps.db().appliedMigrations(), timeoutMs);
  } catch (error) {
    return [
      check(
        'db',
        'fail',
        'База данных недоступна',
        `${errorTag(error)}. Проверьте DATABASE_URL и что база Neon не удалена`,
      ),
    ];
  }
  const expected = deps.expectedMigrations;
  const db = check('db', 'ok', 'База данных доступна');
  if (applied === expected) {
    return [db, check('db.migrations', 'ok', `Миграции применены: ${applied}/${expected}`)];
  }
  if (applied < expected) {
    return [
      db,
      check('db.migrations', 'fail', `Применено миграций: ${applied} из ${expected}`, MIGRATE_HINT),
    ];
  }
  return [
    db,
    check(
      'db.migrations',
      'warn',
      `В базе больше миграций, чем знает код: ${applied} из ${expected}`,
      'База новее кода: задеплойте последнюю версию',
    ),
  ];
}

const BOT_APPLY_HINT =
  'Нажмите «Настроить бота» (или pnpm selfhost:check --apply --expect-bot <имя бота>)';

function botStatusChecks(status: BotStatus): Check[] {
  const out: Check[] = [check('bot', 'ok', `Бот @${status.username} отвечает`)];
  const { webhook } = status;
  if (webhook.url === '') {
    out.push(check('bot.webhook', 'fail', 'Webhook не установлен', BOT_APPLY_HINT));
  } else if (!webhook.ok) {
    out.push(check('bot.webhook', 'fail', 'Webhook указывает на другой адрес', BOT_APPLY_HINT));
  } else if (webhook.lastErrorMessage !== null) {
    const when = webhook.lastErrorDate === null ? '' : ` (${webhook.lastErrorDate.toISOString()})`;
    out.push(
      check(
        'bot.webhook',
        'warn',
        `Telegram сообщает об ошибке webhook${when}: ${webhook.lastErrorMessage}`,
        `Если ошибка свежая – проверьте логи функции /api/bot в Vercel; ${BOT_APPLY_HINT.toLowerCase()}`,
      ),
    );
  } else {
    out.push(check('bot.webhook', 'ok', 'Webhook указывает на этот сайт'));
  }
  out.push(
    status.menuButton.ok
      ? check('bot.menu', 'ok', 'Кнопка меню открывает Mini App')
      : check('bot.menu', 'fail', 'Кнопка меню не открывает Mini App этого сайта', BOT_APPLY_HINT),
  );
  out.push(
    status.hasMainWebApp
      ? check('bot.main_app', 'ok', 'Main Mini App включена в BotFather')
      : check(
          'bot.main_app',
          'fail',
          'Не включена Main Mini App в BotFather – не будут работать ссылки “Поделиться”',
          'BotFather → /mybots → ваш бот → Bot Settings → Configure Mini App → Enable Mini App, адрес – адрес этого сайта',
        ),
  );
  return out;
}

async function botChecks(deps: CheckDeps, timeoutMs: number): Promise<Check[]> {
  let env;
  try {
    env = getBotEnv(deps.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return [check('bot', 'warn', 'Бот не проверен', ENV_FIRST)];
  }
  try {
    const status = await withTimeout(
      botStatus(deps.botApi(env.TELEGRAM_BOT_TOKEN), env.APP_URL),
      timeoutMs,
    );
    return botStatusChecks(status);
  } catch (error) {
    const code = (error as { error_code?: unknown }).error_code;
    if (code === 401 || code === 404) {
      return [
        check(
          'bot',
          'fail',
          'Telegram не принял токен бота',
          'Скопируйте токен заново в @BotFather → /mybots → API Token и обновите TELEGRAM_BOT_TOKEN',
        ),
      ];
    }
    return [check('bot', 'fail', 'Telegram API недоступен', errorTag(error))];
  }
}

const modelId = (name: unknown): string | null =>
  typeof name === 'string' ? name.replace(/^models\//, '') : null;

const modelNames = (body: unknown): Set<string> => {
  const models = (body as { models?: unknown } | null)?.models;
  const ids = new Set<string>();
  if (!Array.isArray(models)) return ids;
  for (const model of models) {
    const id = modelId((model as { name?: unknown } | null)?.name);
    if (id !== null) ids.add(id);
  }
  return ids;
};

const BAD_KEY_HINT =
  'Проверьте GOOGLE_GENERATIVE_AI_API_KEY (ключ из aistudio.google.com/apikey) и сделайте Redeploy';

async function llmChecks(deps: CheckDeps, timeoutMs: number): Promise<Check[]> {
  let env;
  try {
    env = getLlmEnv(deps.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return [check('llm', 'fail', 'Не задан ключ LLM', BAD_KEY_HINT)];
  }
  const viaProxy = env.LLM_BASE_URL !== undefined;
  const base = env.LLM_BASE_URL ?? GOOGLE_API_BASE;
  let res: Response;
  try {
    res = await withTimeout(
      deps.fetch(`${base}/models?pageSize=1000`, {
        method: 'GET',
        headers: { 'x-goog-api-key': env.GOOGLE_GENERATIVE_AI_API_KEY ?? '' },
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
    );
  } catch (error) {
    return [
      check(
        'llm',
        viaProxy ? 'warn' : 'fail',
        viaProxy ? 'Прокси LLM недоступен' : 'API Gemini недоступен',
        errorTag(error),
      ),
    ];
  }

  // Google answers a malformed key with 400 API_KEY_INVALID, a revoked one with 401/403.
  if (res.status === 401 || res.status === 403 || (res.status === 400 && !viaProxy)) {
    return [check('llm', 'fail', 'Ключ LLM не принят', BAD_KEY_HINT)];
  }
  if (viaProxy && (res.status === 404 || res.status === 405)) {
    return [
      check(
        'llm',
        'warn',
        'Не удалось проверить ключ LLM через прокси',
        'Прокси не отдаёт список моделей; ключ проверится при первой сборке выпуска',
      ),
    ];
  }
  if (res.status === 429) {
    return [
      check(
        'llm',
        'warn',
        'Ключ LLM упёрся в лимит запросов',
        'Подождите минуту; если повторяется – закончилась дневная квота бесплатного ключа',
      ),
    ];
  }
  if (!res.ok) {
    return [check('llm', viaProxy ? 'warn' : 'fail', `LLM API ответил ошибкой HTTP ${res.status}`)];
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const available = modelNames(body);
  const wanted = [
    ['LLM_MODEL_FAST', env.LLM_MODEL_FAST],
    ['LLM_MODEL_SMART', env.LLM_MODEL_SMART],
  ] as const;
  const missing = wanted.filter(([, id]) => !available.has(id));
  if (missing.length === 0) {
    return [
      check(
        'llm',
        'ok',
        `Ключ LLM работает, модели ${env.LLM_MODEL_FAST} и ${env.LLM_MODEL_SMART} доступны`,
      ),
    ];
  }
  return [
    check(
      'llm',
      viaProxy ? 'warn' : 'fail',
      `Ключ LLM работает, но модели нет в списке: ${missing.map(([, id]) => id).join(', ')}`,
      `Проверьте ${missing.map(([key]) => key).join(', ')} (пусто = модель по умолчанию)`,
    ),
  ];
}

async function scheduleChecks(deps: CheckDeps, timeoutMs: number): Promise<Check[]> {
  try {
    getCronEnv(deps.env);
    getDatabaseUrl({}, deps.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return [check('schedule', 'warn', 'Расписание не проверено', ENV_FIRST)];
  }
  let overdue: number;
  try {
    const before = new Date(deps.now().getTime() - OVERDUE_MS);
    overdue = await withTimeout(deps.db().overdueSchedules(before), timeoutMs);
  } catch (error) {
    return [check('schedule', 'warn', 'Расписание не проверено: база недоступна', errorTag(error))];
  }
  if (overdue > 0) {
    return [
      check(
        'schedule',
        'warn',
        'Будильник не срабатывает – настройте cron-job.org',
        `Выпусков по расписанию опаздывает больше чем на 2 часа: ${overdue}. Настройки задания – в блоке cron-job.org (или pnpm selfhost:check --show-cron)`,
      ),
    ];
  }
  return [check('schedule', 'ok', 'Выпуски по расписанию не опаздывают')];
}

/**
 * Read-only health checklist of a deploy: env, database, bot, LLM key, schedule. Every
 * external call is injected; the LLM is only asked for its model list, never to generate.
 */
export async function runChecks(deps: CheckDeps): Promise<Check[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sections = await Promise.all([
    Promise.resolve(envChecks(deps.env)),
    dbChecks(deps, timeoutMs),
    botChecks(deps, timeoutMs),
    llmChecks(deps, timeoutMs),
    scheduleChecks(deps, timeoutMs),
  ]);
  return sections.flat();
}
