import { mskDay, mskDayRange } from '@/pipeline/day';

import {
  DAILY_BUILDS,
  FREE_FAILURE_CODES,
  issueErrorCodes,
  QUOTA_EXEMPT_CODES,
  type IssueErrorCode,
  type IssueState,
  type IssueStatus,
  type Quota,
} from './contract';

/** An in-flight issue older than this is dead (the function ran out of maxDuration). */
export const STALE_MS = 330_000;
/** The pipeline stops itself well before Vercel's 300s maxDuration. */
export const PIPELINE_BUDGET_MS = 270_000;

const IN_FLIGHT: ReadonlySet<IssueStatus> = new Set([
  'pending',
  'collecting',
  'digesting',
  'composing',
]);

export const isInFlight = (status: IssueStatus): boolean => IN_FLIGHT.has(status);

const KNOWN_CODES: ReadonlySet<string> = new Set(issueErrorCodes);

/** issues.error is "<code>: <message>" for pipeline errors, free text for anything else. */
export function errorCode(error: string | null): IssueErrorCode {
  const prefix = /^([a-z_]+):/.exec(error ?? '')?.[1];
  return prefix !== undefined && KNOWN_CODES.has(prefix) ? (prefix as IssueErrorCode) : 'internal';
}

export interface IssueStateRow {
  id: string;
  status: IssueStatus;
  error: string | null;
  number: number | null;
  digestsDone: number;
  digestsTotal: number;
  createdAt: Date;
  /** issues.stats_json (IssueStats); only read for failures. */
  stats?: unknown;
}

function foundOf(stats: unknown): IssueState['found'] {
  if (typeof stats !== 'object' || stats === null) return undefined;
  const { messages, channels } = stats as Record<string, unknown>;
  if (typeof messages !== 'number' || typeof channels !== 'number') return undefined;
  return { posts: messages, channels };
}

export const isStale = (row: Pick<IssueStateRow, 'status' | 'createdAt'>, now: Date): boolean =>
  isInFlight(row.status) && now.getTime() - row.createdAt.getTime() > STALE_MS;

export function progressOf(row: IssueStateRow): IssueState['progress'] {
  switch (row.status) {
    case 'pending':
    case 'collecting':
      return { step: 'collecting', done: null, total: null };
    case 'digesting':
      return { step: 'digesting', done: row.digestsDone, total: row.digestsTotal };
    case 'composing':
      return { step: 'composing', done: null, total: null };
    default:
      return null;
  }
}

/** What the client sees: a stale in-flight issue is reported as failed/timeout. */
export function issueState(row: IssueStateRow, now: Date): IssueState {
  if (isStale(row, now)) {
    return { id: row.id, status: 'failed', progress: null, error: 'timeout', number: null };
  }
  const error = row.status === 'failed' ? errorCode(row.error) : null;
  const found = error === 'no_news' ? foundOf(row.stats) : undefined;
  return {
    id: row.id,
    status: row.status,
    progress: progressOf(row),
    error,
    number: row.status === 'ready' ? row.number : null,
    ...(found ? { found } : {}),
  };
}

export { FREE_FAILURE_CODES, QUOTA_EXEMPT_CODES };

type CountedRow = { status: IssueStatus; error: string | null };

const isFailedWith = (row: CountedRow, codes: readonly IssueErrorCode[]): boolean =>
  row.status === 'failed' && codes.includes(errorCode(row.error));

/** Per-user manual quota; the store's SQL filter is built from the same QUOTA_EXEMPT_CODES. */
export const countsTowardQuota = (row: CountedRow): boolean =>
  !isFailedWith(row, QUOTA_EXEMPT_CODES);

/** Global daily cap (LLM spend); the store's SQL filter is built from FREE_FAILURE_CODES. */
export const countsTowardSpend = (row: CountedRow): boolean =>
  !isFailedWith(row, FREE_FAILURE_CODES);

/** Start of the current Moscow day: quotas reset at 00:00 MSK. */
export const quotaDayStart = (now: Date): Date => mskDayRange(mskDay(now)).start;

/** null = unlimited (owner). */
export function quota(used: number, owner: boolean, limit = DAILY_BUILDS): Quota | null {
  if (owner) return null;
  return { limit, used, remaining: Math.max(0, limit - used) };
}
