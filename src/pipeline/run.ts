import type { CollectResult } from '@/collector';
import type { Llm } from '@/llm/client';
import { LlmQuotaExhaustedError, type RateLimitRetryOptions } from '@/llm/retry';
import { addUsage, emptyUsage, type TokenUsage } from '@/llm/usage';

import { composeIssue } from './compose';
import { issueWindow, mskDayRange, type Period } from './day';
import { summarizeChannelDay } from './digest';
import { DeadlineError, NoPostsError, PipelineError, safeMessage } from './errors';
import { COMPOSE_PROMPT_VERSION, DIGEST_PROMPT_VERSION } from './prompts';
import type { DroppedStats } from './resolve';
import type { Issue } from './schema';
import type { DigestStore, IssueStore, UserChannelRow } from './store';

export interface PipelineDeps {
  issues: IssueStore;
  digests: DigestStore;
  /** Collects posts for usernames since a date (collector seam). */
  collect: (usernames: readonly string[], since: Date) => Promise<CollectResult[]>;
  llm: Llm;
  now: () => Date;
  log?: (line: string) => void;
  /** Max digest LLM calls in flight; defaults to llm.concurrency (LLM_CONCURRENCY), then 3. */
  digestConcurrency?: number;
  /** Called once after the issue is ready; its failure never fails the issue. */
  notify?: (notice: { issueId: string; userId: number; number: number }) => Promise<unknown>;
}

export interface IssueStats {
  messages: number;
  channels: number;
  collect: {
    ok: number;
    failed: number;
    inserted: number;
    errors: { channel: string; code: string; message: string }[];
  };
  digests: { total: number; cached: number; generated: number; empty: number; failed: number };
  digestErrors: { channel: string; day: string; message: string }[];
  compose: { items: number; trimmed: boolean; attempts: number };
  dropped: DroppedStats;
  lead: { facts: number };
  tokens: { digest: TokenUsage; compose: TokenUsage };
  models: { fast: string; smart: string; digestPrompt: string; composePrompt: string };
}

export interface IssueRun {
  issueId: string;
  userId: number;
  interests: string | null;
  period: Period;
  channels: UserChannelRow[];
  stats: IssueStats;
  options: { refreshDigests: boolean };
  /** Start of the earliest touched MSK day: collect always covers whole days. */
  collectSince: Date;
  /** Usernames whose collect succeeded in this run. */
  collected: Set<string>;
}

const newStats = (llm: Llm): IssueStats => ({
  messages: 0,
  channels: 0,
  collect: { ok: 0, failed: 0, inserted: 0, errors: [] },
  digests: { total: 0, cached: 0, generated: 0, empty: 0, failed: 0 },
  digestErrors: [],
  compose: { items: 0, trimmed: false, attempts: 0 },
  dropped: { refs: 0, notes: 0, duplicates: 0 },
  lead: { facts: 0 },
  tokens: { digest: emptyUsage(), compose: emptyUsage() },
  models: {
    fast: llm.fast.id,
    smart: llm.smart.id,
    digestPrompt: DIGEST_PROMPT_VERSION,
    composePrompt: COMPOSE_PROMPT_VERSION,
  },
});

const collectStart = (period: Period): Date => {
  const first = period.days[0];
  if (first === undefined) throw new Error('empty period');
  return mskDayRange(first).start;
};

export interface IssueRunInput {
  userId: number;
  /** Longest window: the schedule's every-N-days (1 when off) or the CLI's --days. */
  maxDays: number;
  interests: string | null;
  refreshDigests?: boolean;
}

/** The window of the user's next issue: continues from the last ready issue, capped at maxDays. */
export async function planIssuePeriod(
  deps: Pick<PipelineDeps, 'issues' | 'now'>,
  input: { userId: number; maxDays: number },
): Promise<Period> {
  const previousEnd = await deps.issues.lastReadyPeriodEnd(input.userId);
  return issueWindow({ maxDays: input.maxDays, now: deps.now(), previousEnd });
}

/** Run state for an issue row that already exists in status pending. */
export function newIssueRun(
  deps: Pick<PipelineDeps, 'llm'>,
  input: {
    issueId: string;
    userId: number;
    period: Period;
    interests: string | null;
    refreshDigests?: boolean;
  },
): IssueRun {
  return {
    issueId: input.issueId,
    userId: input.userId,
    interests: input.interests,
    period: input.period,
    channels: [],
    stats: newStats(deps.llm),
    options: { refreshDigests: input.refreshDigests ?? false },
    collectSince: collectStart(input.period),
    collected: new Set(),
  };
}

export async function createIssueRecord(
  deps: PipelineDeps,
  input: IssueRunInput,
): Promise<IssueRun> {
  const period = await planIssuePeriod(deps, input);
  const issue = await deps.issues.create(input.userId, period);
  return newIssueRun(deps, { ...input, issueId: issue.id, period });
}

/**
 * Time kept for compose (one smart LLM call, with retries) before the deadline: digests stop
 * being scheduled once less than this remains, and compose never starts with less.
 */
export const COMPOSE_RESERVE_MS = 60_000;

export interface ExecuteOptions {
  /** Past this instant the run stops between steps (or digest tasks) as failed('timeout'). */
  deadline?: Date;
  /** Defaults to COMPOSE_RESERVE_MS; only meaningful with a deadline. */
  composeReserveMs?: number;
  /** false skips the "issue ready" message (the user never allowed the bot to write). */
  notifyAllowed?: boolean;
}

const pastDeadline = (deps: Pick<PipelineDeps, 'now'>, options: ExecuteOptions): boolean =>
  options.deadline !== undefined && deps.now().getTime() >= options.deadline.getTime();

/** Too little time left to compose: stop digesting and fail before the smart call. */
const pastComposeCutoff = (deps: Pick<PipelineDeps, 'now'>, options: ExecuteOptions): boolean =>
  options.deadline !== undefined &&
  deps.now().getTime() >=
    options.deadline.getTime() - (options.composeReserveMs ?? COMPOSE_RESERVE_MS);

const checkDeadline = (deps: Pick<PipelineDeps, 'now'>, options: ExecuteOptions): void => {
  if (pastDeadline(deps, options)) throw new DeadlineError();
};

/**
 * Time a digest batch retried after a 429 needs: a flash-lite batch takes ~5-15s. With less
 * left before the compose cutoff the retry would eat into the compose reserve.
 */
export const DIGEST_MIN_ATTEMPT_MS = 15_000;

/**
 * Time a compose retried after a 429 needs before the deadline. Half the reserve (the reserve
 * is sized for a whole compose with its retries), never under 30s: a smart call that cannot
 * finish in time would outlive the function (maxDuration) and leave the issue in composing.
 */
export const COMPOSE_MIN_ATTEMPT_MS = 30_000;

const composeMinAttemptMs = (options: ExecuteOptions): number =>
  Math.max(COMPOSE_MIN_ATTEMPT_MS, (options.composeReserveMs ?? COMPOSE_RESERVE_MS) / 2);

/** 429 waits only when the retried call still fits before `deadline`. */
const retryUntil = (
  deps: Pick<PipelineDeps, 'now'>,
  deadline: Date | undefined,
  minAttemptMs: number,
): RateLimitRetryOptions => ({ deadline, minAttemptMs, now: deps.now });

const composeCutoff = (options: ExecuteOptions): Date | undefined =>
  options.deadline === undefined
    ? undefined
    : new Date(options.deadline.getTime() - (options.composeReserveMs ?? COMPOSE_RESERVE_MS));

export async function runCollectStep(deps: PipelineDeps, run: IssueRun): Promise<void> {
  await deps.issues.transition(run.issueId, 'pending', 'collecting');
  const channels = await deps.issues.getUserChannels(run.userId);
  if (channels.length === 0) {
    throw new PipelineError('no_channels', 'no_channels: the user has no channels');
  }
  const results = await deps.collect(
    channels.map((channel) => channel.username),
    run.collectSince,
  );
  for (const result of results) {
    if (result.ok) {
      run.collected.add(result.username);
      run.stats.collect.ok += 1;
      run.stats.collect.inserted += result.inserted;
    } else {
      run.stats.collect.failed += 1;
      run.stats.collect.errors.push({
        channel: result.username,
        code: result.code,
        message: result.message.slice(0, 200),
      });
    }
  }
  deps.log?.(
    `collect: ${run.stats.collect.ok} ok, ${run.stats.collect.failed} failed, ${run.stats.collect.inserted} new posts`,
  );

  // Titles may have been filled in by collect.
  run.channels = await deps.issues.getUserChannels(run.userId);
  const counts = await deps.issues.periodCounts(run.userId, run.period);
  run.stats.messages = counts.messages;
  run.stats.channels = counts.channels;
  if (counts.messages === 0) {
    // A total collect failure with nothing cached is a collect error, not an empty period.
    if (run.stats.collect.ok === 0) {
      throw new PipelineError('collect_failed', 'collect_failed: every channel failed to collect');
    }
    throw new NoPostsError();
  }
}

export async function runDigestStep(
  deps: PipelineDeps,
  run: IssueRun,
  options: ExecuteOptions = {},
): Promise<void> {
  const tasks = run.channels.flatMap((channel) => run.period.days.map((day) => ({ channel, day })));
  const digests = run.stats.digests;
  digests.total = tasks.length;
  await deps.issues.transition(run.issueId, 'collecting', 'digesting', {
    digestsTotal: tasks.length,
    digestsDone: 0,
    stats: run.stats,
  });

  let done = 0;
  let next = 0;
  // A spent daily quota fails every remaining call too: stop scheduling and fail the issue.
  let quotaError: LlmQuotaExhaustedError | undefined;
  const retry = retryUntil(deps, composeCutoff(options), DIGEST_MIN_ATTEMPT_MS);
  // period.end precedes the collect start, so every post up to it was scraped.
  const watermark = run.period.end;
  const worker = async (): Promise<void> => {
    // Digests finished before the cutoff are already cached, so a retry starts further along.
    while (next < tasks.length && quotaError === undefined && !pastComposeCutoff(deps, options)) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) continue;
      try {
        const outcome = await summarizeChannelDay(
          { store: deps.digests, fast: deps.llm.fast, retry },
          task.channel,
          task.day,
          watermark,
          {
            force: run.options.refreshDigests,
            // Final only if this run scraped the whole day for this channel.
            complete:
              run.collected.has(task.channel.username) &&
              run.collectSince.getTime() <= mskDayRange(task.day).start.getTime(),
          },
        );
        digests[outcome.status] += 1;
        run.stats.tokens.digest = addUsage(run.stats.tokens.digest, outcome.usage);
      } catch (error) {
        if (error instanceof LlmQuotaExhaustedError) quotaError ??= error;
        digests.failed += 1;
        run.stats.digestErrors.push({
          channel: task.channel.username,
          day: task.day,
          message: safeMessage(error).slice(0, 200),
        });
      }
      done += 1;
      await deps.issues.progress(run.issueId, { digestsDone: done });
    }
  };
  const concurrency = deps.digestConcurrency ?? deps.llm.concurrency ?? 3;
  const workers = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (quotaError !== undefined) throw quotaError;
  if (done < tasks.length) throw new DeadlineError();

  deps.log?.(
    `digest: ${digests.total} total, ${digests.cached} cached, ${digests.generated} generated, ${digests.empty} empty, ${digests.failed} failed`,
  );
  if (digests.failed * 2 > digests.total) {
    throw new PipelineError(
      'digest_failed',
      `digest_failed: ${digests.failed} of ${digests.total} digests failed (${run.stats.digestErrors[0]?.message ?? ''})`,
    );
  }
}

export async function runComposeStep(
  deps: PipelineDeps,
  run: IssueRun,
  options: ExecuteOptions = {},
): Promise<{ number: number; content: Issue }> {
  await deps.issues.transition(run.issueId, 'digesting', 'composing', { stats: run.stats });
  const composed = await composeIssue(
    {
      digests: deps.digests,
      issues: deps.issues,
      smart: deps.llm.smart,
      retry: retryUntil(deps, options.deadline, composeMinAttemptMs(options)),
    },
    { userId: run.userId, channels: run.channels, period: run.period, interests: run.interests },
  );
  run.stats.messages = composed.messages;
  run.stats.channels = composed.channels;
  run.stats.compose = {
    items: composed.items,
    trimmed: composed.trimmed,
    attempts: composed.attempts,
  };
  run.stats.dropped = composed.dropped;
  run.stats.lead = { facts: composed.content.lead.facts.length };
  run.stats.tokens.compose = composed.usage;

  let content: Issue | undefined;
  const number = await deps.issues.complete(run.issueId, (assigned) => {
    content = composed.build(assigned);
    return { content, stats: run.stats };
  });
  if (content === undefined) throw new Error('issue content was not built');
  return { number, content };
}

export interface PipelineResult {
  issueId: string;
  number: number;
  content: Issue;
  stats: IssueStats;
}

/** Runs the steps of an existing pending issue; marks it failed on any error. */
export async function executeIssueRun(
  deps: PipelineDeps,
  run: IssueRun,
  options: ExecuteOptions = {},
): Promise<PipelineResult> {
  let result: PipelineResult;
  try {
    checkDeadline(deps, options);
    await runCollectStep(deps, run);
    checkDeadline(deps, options);
    await runDigestStep(deps, run, options);
    if (pastComposeCutoff(deps, options)) throw new DeadlineError();
    const { number, content } = await runComposeStep(deps, run, options);
    result = { issueId: run.issueId, number, content, stats: run.stats };
  } catch (error) {
    const message = safeMessage(error);
    try {
      await deps.issues.fail(run.issueId, message, run.stats);
    } catch (failError) {
      // The original error is what the caller needs; the status write is best effort.
      deps.log?.(`issue ${run.issueId}: could not mark failed: ${safeMessage(failError)}`);
    }
    throw new IssueFailedError(run.issueId, message, run.stats);
  }

  if (deps.notify !== undefined && options.notifyAllowed !== false) {
    try {
      await deps.notify({ issueId: result.issueId, userId: run.userId, number: result.number });
    } catch (error) {
      deps.log?.(`issue ${run.issueId}: notify failed: ${safeMessage(error)}`);
    }
  }
  return result;
}

/** Creates the issue and runs every step in-process (CLI); steps stay resumable on their own. */
export async function runIssuePipeline(
  deps: PipelineDeps,
  input: IssueRunInput,
): Promise<PipelineResult> {
  const run = await createIssueRecord(deps, input);
  deps.log?.(`issue ${run.issueId}: pending`);
  return executeIssueRun(deps, run);
}

export class IssueFailedError extends Error {
  override readonly name = 'IssueFailedError';
  constructor(
    readonly issueId: string,
    message: string,
    readonly stats: IssueStats,
  ) {
    super(message);
  }
}
