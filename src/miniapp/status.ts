import { mskDay, mskDayRange } from '@/pipeline/day';

import {
  DAILY_BUILDS,
  issueErrorCodes,
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

/** Failures that cost no LLM money: they do not use up the daily quota. */
export const QUOTA_EXEMPT_CODES: readonly IssueErrorCode[] = [
  'no_channels',
  'no_posts',
  'collect_failed',
];

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
  return {
    id: row.id,
    status: row.status,
    progress: progressOf(row),
    error: row.status === 'failed' ? errorCode(row.error) : null,
    number: row.status === 'ready' ? row.number : null,
  };
}

/** Mirrors the SQL filter in the store's quota count. */
export const countsTowardQuota = (row: { status: IssueStatus; error: string | null }): boolean =>
  !(row.status === 'failed' && QUOTA_EXEMPT_CODES.includes(errorCode(row.error)));

/** Start of the current Moscow day: quotas reset at 00:00 MSK. */
export const quotaDayStart = (now: Date): Date => mskDayRange(mskDay(now)).start;

/** null = unlimited (owner). */
export function quota(used: number, owner: boolean, limit = DAILY_BUILDS): Quota | null {
  if (owner) return null;
  return { limit, used, remaining: Math.max(0, limit - used) };
}
