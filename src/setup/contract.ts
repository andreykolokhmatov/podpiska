// Client-safe: shared by POST /api/setup and the /setup page. No node imports here.

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type CheckId =
  | 'env'
  | 'env.access'
  | 'db'
  | 'db.migrations'
  | 'bot'
  | 'bot.webhook'
  | 'bot.menu'
  | 'bot.main_app'
  | 'llm'
  | 'schedule';

export interface Check {
  id: CheckId;
  status: CheckStatus;
  /** Russian, one line; never contains a secret value. */
  title: string;
  /** What to do about it (Russian); never contains a secret value. */
  hint?: string;
}

export const SETUP_ACTIONS = ['check', 'apply', 'cron'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** Body of POST /api/setup (JSON). `token` is the bot token from @BotFather. */
export interface SetupRequest {
  token: string;
  action: SetupAction;
}

/** 200 for action 'check' and 'apply'. */
export interface SetupChecksResponse {
  checks: Check[];
  /** ISO time the checks ran; a cached result (≤60s) keeps its original time. */
  checkedAt: string;
  /** Only for 'apply': whether configuring the bot (webhook, commands, menu button) succeeded. */
  apply?: { ok: true } | { ok: false; error: string };
}

/** 200 for action 'cron': the cron-job.org job settings. `value` is a secret. */
export interface SetupCronResponse {
  url: string;
  method: 'POST';
  header: 'Authorization';
  value: string;
}

export type SetupErrorCode =
  /** Missing or wrong token (401). */
  | 'unauthorized'
  /** Malformed body (400). */
  | 'bad_request'
  /** Too many wrong tokens from this address; retry after a minute (429). */
  | 'rate_limited'
  /** 'apply' on a non-production deploy (VERCEL_ENV preview/development) (409). */
  | 'not_production'
  /** The deploy's own env is unusable for this action, e.g. no TELEGRAM_BOT_TOKEN (500). */
  | 'misconfigured'
  | 'internal';

export interface SetupErrorResponse {
  error: SetupErrorCode;
}

export type SetupResponse = SetupChecksResponse | SetupCronResponse | SetupErrorResponse;

/** Whole-result rollup for a header line: any fail → fail, any warn → warn. */
export function overallStatus(checks: readonly Check[]): CheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}
