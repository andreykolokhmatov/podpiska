import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { IssueReadyNotice, NotifyOutcome } from '@/bot/notify';
import { EnvError, type CronEnv } from '@/lib/env';
import type { IssueErrorCode } from '@/miniapp/contract';
import { errorCode, PIPELINE_BUDGET_MS, quotaDayStart, STALE_MS } from '@/miniapp/status';
import type { ClaimInput, ClaimResult } from '@/miniapp/store';
import { safeMessage } from '@/pipeline/errors';
import { executeIssueRun, newIssueRun, planIssuePeriod, type PipelineDeps } from '@/pipeline/run';

import { applyNotifyOutcome, FRESH_GAP_MS, slotAfterSlot } from './service';
import type { ScheduleStore } from './store';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Users started per tick, and how many run requests are in flight at once. */
export const TICK_LIMIT = 10;
export const TICK_CONCURRENCY = 3;
const RUN_FETCH_TIMEOUT_MS = 10_000;
/** Scheduled issues in a row left unopened before the schedule pauses itself. */
export const UNREAD_PAUSE = 3;
/** Builds per slot, the first included: failures retry an hour later. */
export const SLOT_ATTEMPTS = 3;

/** Empty-period outcomes: a retry would find nothing new, so they stay silent. */
const SILENT: ReadonlySet<IssueErrorCode> = new Set(['no_posts', 'no_news', 'no_channels']);

/** A spent daily LLM quota does not come back within the slot's hourly retries. */
const NO_RETRY: ReadonlySet<IssueErrorCode> = new Set([...SILENT, 'llm_quota']);

export interface CronApiDeps {
  /** Throws EnvError when CRON_SECRET or the bot env is invalid (→ 500, never open). */
  env: () => CronEnv;
  now: () => Date;
  store: ScheduleStore;
  claimIssue: (input: ClaimInput) => Promise<ClaimResult>;
  /** Pipeline wiring without notify; throws EnvError on a bad LLM env (checked before claims). */
  pipeline: () => PipelineDeps;
  /** "Issue ready" through the prod bot. */
  notifyReady: (notice: IssueReadyNotice) => Promise<NotifyOutcome>;
  /** «Мы приостановили газету» through the prod bot. */
  sendPaused: (userId: number) => Promise<NotifyOutcome>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Runs work after the response is sent (next/server `after`). */
  after: (task: () => Promise<void>) => void;
  /** Metadata only: never secrets or interests. */
  log: (line: string) => void;
}

export interface CronApi {
  tick: (req: Request) => Promise<Response>;
  run: (req: Request) => Promise<Response>;
}

export type TickResponse = { due: number; started: number; skipped: number };
export type RunResponse =
  | { status: 'started'; issueId: string }
  | {
      status: 'skipped';
      reason: 'not_due' | 'paused' | 'fresh' | 'busy' | 'limit_global' | 'no_channels';
    };

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: NO_STORE });

const runRequestSchema = z.object({
  userId: z
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1),
});
const MAX_BODY_BYTES = 256;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time Bearer check (hashing first makes the lengths equal). */
export function bearerMatches(header: string | null, secret: string): boolean {
  const match = /^Bearer (\S+)$/.exec(header?.trim() ?? '');
  if (match?.[1] === undefined || secret.length === 0) return false;
  return timingSafeEqual(digest(match[1]), digest(secret));
}

/** First 8 hex chars of the secret's SHA-256: compares two copies without revealing either. */
export const secretFingerprint = (secret: string): string =>
  digest(secret).toString('hex').slice(0, 8);

class Unauthorized extends Error {
  override readonly name = 'Unauthorized';
  constructor(readonly fingerprint: string) {
    super('unauthorized');
  }
}

class BadRequest extends Error {
  override readonly name = 'BadRequest';
}

export function createCronApi(deps: CronApiDeps): CronApi {
  const authorize = (req: Request): CronEnv => {
    const env = deps.env();
    if (!bearerMatches(req.headers.get('authorization'), env.CRON_SECRET)) {
      throw new Unauthorized(secretFingerprint(env.CRON_SECRET));
    }
    return env;
  };

  const route =
    (name: string, fn: (req: Request) => Promise<Response>) =>
    async (req: Request): Promise<Response> => {
      try {
        return await fn(req);
      } catch (error) {
        if (error instanceof Unauthorized) {
          const res = json(401, { error: 'unauthorized' });
          res.headers.set('X-Cron-Secret-Fingerprint', error.fingerprint);
          return res;
        }
        if (error instanceof BadRequest) return json(400, { error: 'bad_request' });
        if (error instanceof EnvError) {
          // EnvError messages list keys and reasons only, never values.
          deps.log(`[cron] ${name}: misconfigured: ${error.message}`);
          return json(500, { error: 'misconfigured' });
        }
        deps.log(`[cron] ${name}: ${error instanceof Error ? error.name : 'unknown'} error`);
        return json(500, { error: 'internal' });
      }
    };

  const tick = route('tick', async (req) => {
    const env = authorize(req);
    const due = await deps.store.dueUsers(deps.now(), TICK_LIMIT);
    let started = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const userId = due[next];
        next += 1;
        if (userId === undefined) continue;
        try {
          const res = await deps.fetch(`${env.APP_URL}/api/cron/run`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${env.CRON_SECRET}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ userId }),
            signal: AbortSignal.timeout(RUN_FETCH_TIMEOUT_MS),
          });
          if (res.status === 202) started += 1;
          else if (!res.ok) deps.log(`[cron] tick: run user ${userId}: http ${res.status}`);
        } catch (error) {
          // One unreachable run must not cost the other users their slot.
          deps.log(
            `[cron] tick: run user ${userId}: ${error instanceof Error ? error.name : 'error'}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TICK_CONCURRENCY, due.length) }, () => worker()),
    );
    const body: TickResponse = { due: due.length, started, skipped: due.length - started };
    deps.log(`[cron] tick: due ${body.due}, started ${body.started}`);
    return json(200, body);
  });

  const readUserId = async (req: Request): Promise<number> => {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new BadRequest();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new BadRequest();
    }
    const parsed = runRequestSchema.safeParse(value);
    if (!parsed.success) throw new BadRequest();
    return parsed.data.userId;
  };

  const skipped = (reason: Extract<RunResponse, { status: 'skipped' }>['reason']): Response =>
    json(200, { status: 'skipped', reason } satisfies RunResponse);

  const handleOutcome = (userId: number, outcome: NotifyOutcome): Promise<void> =>
    applyNotifyOutcome(deps.store, userId, outcome, deps.now());

  const run = route('run', async (req) => {
    const env = authorize(req);
    const userId = await readUserId(req);
    // Fails on a bad LLM env before the slot moves or anything is inserted.
    const pipeline = deps.pipeline();
    const now = deps.now();

    // The row lock makes a double tick harmless: only one run moves the slot.
    const claimed = await deps.store.claimSlot(userId, now, (user) =>
      slotAfterSlot(user, user.nextIssueAt, now),
    );
    if (claimed === undefined) return skipped('not_due');
    const { user, slot } = claimed;
    const windowMs = user.everyDays * DAY_MS;

    const recent = await deps.store.recentReady(userId, UNREAD_PAUSE);
    const unread =
      recent.length === UNREAD_PAUSE &&
      recent.every((issue) => issue.trigger === 'scheduled' && issue.openedAt === null);
    if (unread) {
      if (await deps.store.pause(userId, now)) {
        try {
          await handleOutcome(userId, await deps.sendPaused(userId));
        } catch (error) {
          deps.log(`[cron] run ${userId}: pause notice failed: ${safeMessage(error)}`);
        }
        deps.log(`[cron] run ${userId}: paused (unread)`);
      }
      return skipped('paused');
    }

    // A manual build just ran: a near-empty paper is not worth a build; wait for the next slot.
    const last = recent[0]?.periodEnd;
    if (last !== undefined && last.getTime() > now.getTime() - FRESH_GAP_MS) {
      return skipped('fresh');
    }

    const period = await planIssuePeriod(pipeline, { userId, maxDays: user.everyDays });
    const claim = await deps.claimIssue({
      userId,
      period,
      trigger: 'scheduled',
      since: quotaDayStart(now),
      staleBefore: new Date(now.getTime() - STALE_MS),
      perUserLimit: null,
      globalLimit: env.MAX_BUILDS_PER_DAY_GLOBAL,
    });
    switch (claim.kind) {
      case 'busy':
      case 'limit':
      case 'limit_global':
        // Give the slot back so the next tick tries again.
        await deps.store.rollbackSlot(userId, slot, claimed.next);
        return skipped(claim.kind === 'limit_global' ? 'limit_global' : 'busy');
      case 'no_channels':
        return skipped('no_channels');
      case 'started':
        break;
    }

    const issueId = claim.issue.id;
    const issueRun = newIssueRun(pipeline, { issueId, userId, period, interests: user.interests });
    const deadline = new Date(now.getTime() + PIPELINE_BUDGET_MS);
    const withNotify: PipelineDeps = {
      ...pipeline,
      notify: async (notice) => {
        const outcome = await deps.notifyReady(notice);
        deps.log(`[cron] notify ${notice.issueId}: ${outcome}`);
        await handleOutcome(userId, outcome);
      },
    };
    deps.after(async () => {
      try {
        const result = await executeIssueRun(withNotify, issueRun, { deadline });
        deps.log(`[cron] build ${issueId}: ready №${result.number}`);
      } catch (error) {
        const code = errorCode(safeMessage(error));
        deps.log(`[cron] build ${issueId}: failed: ${code}`);
        if (NO_RETRY.has(code)) return;
        try {
          const failedAt = deps.now();
          const attempts = await deps.store.countSlotAttempts(
            userId,
            new Date(failedAt.getTime() - windowMs / 2),
          );
          if (attempts < SLOT_ATTEMPTS) {
            await deps.store.retrySoon(userId, new Date(failedAt.getTime() + HOUR_MS));
          }
        } catch (retryError) {
          deps.log(`[cron] build ${issueId}: retry not scheduled: ${safeMessage(retryError)}`);
        }
      }
    });
    deps.log(`[cron] build ${issueId}: started for user ${userId}`);
    return json(202, { status: 'started', issueId } satisfies RunResponse);
  });

  return { tick, run };
}
