import type { CollectResult } from '@/collector';
import type { Llm } from '@/llm/client';
import { addUsage, emptyUsage, type TokenUsage } from '@/llm/usage';

import { composeIssue } from './compose';
import { issueWindow, mskDayRange, type Period } from './day';
import { summarizeChannelDay } from './digest';
import { NoPostsError, PipelineError, safeMessage } from './errors';
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
  /** Max digest LLM calls in flight. */
  digestConcurrency?: number;
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

export async function createIssueRecord(
  deps: PipelineDeps,
  input: { userId: number; days: number; interests: string | null; refreshDigests?: boolean },
): Promise<IssueRun> {
  const previousEnd =
    input.days === 1 ? await deps.issues.lastReadyPeriodEnd(input.userId) : undefined;
  const period = issueWindow({ days: input.days, now: deps.now(), previousEnd });
  const issue = await deps.issues.create(input.userId, period);
  return {
    issueId: issue.id,
    userId: input.userId,
    interests: input.interests,
    period,
    channels: [],
    stats: newStats(deps.llm),
    options: { refreshDigests: input.refreshDigests ?? false },
    collectSince: collectStart(period),
    collected: new Set(),
  };
}

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

export async function runDigestStep(deps: PipelineDeps, run: IssueRun): Promise<void> {
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
  // period.end precedes the collect start, so every post up to it was scraped.
  const watermark = run.period.end;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) continue;
      try {
        const outcome = await summarizeChannelDay(
          { store: deps.digests, fast: deps.llm.fast },
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
  const workers = Math.max(1, Math.min(deps.digestConcurrency ?? 3, tasks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

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
): Promise<{ number: number; content: Issue }> {
  await deps.issues.transition(run.issueId, 'digesting', 'composing', { stats: run.stats });
  const composed = await composeIssue(
    { digests: deps.digests, issues: deps.issues, smart: deps.llm.smart },
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

/** Runs every step in-process; each step is resumable on its own (QStash later). */
export async function runIssuePipeline(
  deps: PipelineDeps,
  input: { userId: number; days: number; interests: string | null; refreshDigests?: boolean },
): Promise<PipelineResult> {
  const run = await createIssueRecord(deps, input);
  deps.log?.(`issue ${run.issueId}: pending`);
  try {
    await runCollectStep(deps, run);
    await runDigestStep(deps, run);
    const { number, content } = await runComposeStep(deps, run);
    return { issueId: run.issueId, number, content, stats: run.stats };
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
