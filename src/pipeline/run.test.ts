import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import type { CollectResult } from '@/collector';

import { now, seedStores, validDraft } from './__fixtures__/compose-fixtures';
import { mockStage, promptText, textResult } from './__fixtures__/fakes';
import { COMPOSE_PROMPT_VERSION, DIGEST_PROMPT_VERSION } from './prompts';
import {
  COMPOSE_MIN_ATTEMPT_MS,
  COMPOSE_RESERVE_MS,
  DIGEST_MIN_ATTEMPT_MS,
  executeIssueRun,
  IssueFailedError,
  newIssueRun,
  planIssuePeriod,
  runIssuePipeline,
  type PipelineDeps,
} from './run';

const okCollect = async (usernames: readonly string[]): Promise<CollectResult[]> =>
  usernames.map((username) => ({ username, ok: true, collected: 1, inserted: 0 }));

const setup = (smartAnswer: () => string | Error, collect: PipelineDeps['collect'] = okCollect) => {
  const { digests, issues } = seedStores();
  const fast = mockStage('fast', () => JSON.stringify({ items: [] }));
  const smart = mockStage('smart', smartAnswer);
  const deps: PipelineDeps = {
    issues,
    digests,
    collect,
    llm: { fast: fast.stage, smart: smart.stage },
    now: () => now,
  };
  return { deps, issues, digests, fast, smart };
};

const input = { userId: 1, maxDays: 1, interests: null };

describe('runIssuePipeline', () => {
  it('walks pending → collecting → digesting → composing → ready', async () => {
    const { deps, issues, fast } = setup(() => JSON.stringify(validDraft()));
    const result = await runIssuePipeline(deps, input);

    const record = issues.issues.get(result.issueId);
    expect(record?.history).toEqual(['pending', 'collecting', 'digesting', 'composing', 'ready']);
    expect(result.number).toBe(1);
    expect(record?.number).toBe(1);
    // 2 channels × 2 touched MSK days. The fake store has no posts, so digesting makes no fast calls; compose reads seeded digests.
    expect(result.stats.digests).toMatchObject({ total: 4, empty: 4, generated: 0, failed: 0 });
    expect(fast.model.doGenerateCalls).toHaveLength(0);
    expect(result.stats.lead).toEqual({ facts: 0 });
    expect(result.stats.models).toEqual({
      fast: 'fast',
      smart: 'smart',
      digestPrompt: DIGEST_PROMPT_VERSION,
      composePrompt: COMPOSE_PROMPT_VERSION,
    });
  });

  it('starts a daily issue where the previous ready issue ended and collects from there', async () => {
    const since: Date[] = [];
    const { deps, issues } = setup(
      () => JSON.stringify(validDraft()),
      async (usernames, from) => {
        since.push(from);
        return okCollect(usernames);
      },
    );
    const first = await runIssuePipeline(deps, input);
    // Collect covers whole touched MSK days: the window starts on the 14th MSK.
    expect(since[0]?.toISOString()).toBe('2026-11-13T21:00:00.000Z');

    const later = new Date(now.getTime() + 3_600_000);
    // New posts after the first issue; the old ones fall outside the second window.
    issues.postsMeta = issues.postsMeta.map((meta) => ({
      ...meta,
      publishedAt: new Date(now.getTime() + 60_000),
    }));
    const second = await runIssuePipeline({ ...deps, now: () => later }, input);
    const record = issues.issues.get(second.issueId);
    expect(record?.periodStart).toEqual(issues.issues.get(first.issueId)?.periodEnd);
    expect(since[1]?.toISOString()).toBe('2026-11-14T21:00:00.000Z');
    expect(second.content.masthead.dateline).toBe('15 ноября 2026');
  });

  it('assigns numbers only to ready issues', async () => {
    let fail = true;
    const { deps, issues } = setup(() =>
      fail ? new Error('provider down') : JSON.stringify(validDraft()),
    );
    await expect(runIssuePipeline(deps, input)).rejects.toThrow(IssueFailedError);
    fail = false;
    const ok = await runIssuePipeline(deps, input);
    expect(ok.number).toBe(1);
    const numbers = [...issues.issues.values()].map((issue) => [issue.status, issue.number]);
    expect(numbers).toEqual([
      ['failed', null],
      ['ready', 1],
    ]);
  });

  it('numbers past a soft-deleted issue: deleted numbers stay taken', async () => {
    const { deps, issues } = setup(() => JSON.stringify(validDraft()));
    const first = await runIssuePipeline(deps, input);
    const record = issues.issues.get(first.issueId);
    if (record === undefined) throw new Error('no record');
    record.deletedAt = now;
    const second = await runIssuePipeline(deps, input);
    expect([first.number, second.number]).toEqual([1, 2]);
  });

  it('marks the issue failed with only the error message', async () => {
    const { deps, issues } = setup(() => new Error('Payment Required'));
    const error = await runIssuePipeline(deps, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueFailedError);
    const record = [...issues.issues.values()][0];
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('Payment Required');
    expect(record?.history.at(-1)).toBe('failed');
  });

  it('saves digests final only for channels whose collect succeeded', async () => {
    const { deps, digests } = setup(
      () => JSON.stringify(validDraft()),
      async (usernames) =>
        usernames.map((username) =>
          username === 'econ'
            ? { username, ok: false, code: 'Network', message: 'down' }
            : { username, ok: true, collected: 1, inserted: 1 },
        ),
    );
    const yesterdayPost = (id: number) => ({
      id,
      tgPostId: id,
      text: `Пост ${id}`,
      publishedAt: new Date('2026-11-14T18:00:00Z'),
    });
    digests.posts.set(1, [yesterdayPost(301)]);
    digests.posts.set(2, [yesterdayPost(302)]);
    deps.llm.fast = mockStage('fast', (prompt) => {
      const id = Number(/<post id="(\d+)"/.exec(prompt)?.[1]);
      return JSON.stringify({
        items: [{ title: 'T', summary: 'S', importance: 3, topics: [], postIds: [id] }],
      });
    }).stage;
    await runIssuePipeline(deps, input);

    const dayEnd = new Date('2026-11-14T21:00:00Z').getTime();
    const ok = digests.digests.get('1:2026-11-14');
    const failed = digests.digests.get('2:2026-11-14');
    expect(ok?.computedAt.getTime()).toBe(now.getTime());
    expect(ok?.computedAt.getTime()).toBeGreaterThanOrEqual(dayEnd);
    expect(failed?.computedAt.getTime()).toBeLessThan(dayEnd);
  });

  it('stores no request body, headers or url from a provider error', async () => {
    const { deps, issues } = setup(
      () =>
        new APICallError({
          message: 'Payment Required',
          url: 'https://proxy.example/google/v1beta/models/smart:generateContent',
          requestBodyValues: { contents: 'PROMPT-BODY' },
          statusCode: 402,
          responseHeaders: { 'x-goog-api-key': 'SECRET' },
          responseBody: '{"error":"RESPONSE-BODY"}',
          isRetryable: false,
        }),
    );
    const error = await runIssuePipeline(deps, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueFailedError);
    const stored = [...issues.issues.values()][0]?.error ?? '';
    expect(stored).toContain('Payment Required');
    for (const leak of [
      'SECRET',
      'x-goog-api-key',
      'PROMPT-BODY',
      'RESPONSE-BODY',
      'proxy.example',
    ]) {
      expect(stored).not.toContain(leak);
    }
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('still throws the original error when marking the issue failed fails', async () => {
    const { deps, issues } = setup(() => new Error('Payment Required'));
    issues.failError = new Error('db down');
    const error = await runIssuePipeline(deps, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueFailedError);
    expect((error as Error).message).toContain('Payment Required');
  });

  it('fails as collect_failed when every channel fails and nothing is stored', async () => {
    const { deps, issues } = setup(
      () => JSON.stringify(validDraft()),
      async (usernames) =>
        usernames.map((username) => ({ username, ok: false, code: 'Network', message: 'down' })),
    );
    issues.counts = { messages: 0, channels: 0 };
    await expect(runIssuePipeline(deps, input)).rejects.toThrow(/collect_failed/);
  });

  it('notifies once after the issue is ready', async () => {
    const { deps, issues } = setup(() => JSON.stringify(validDraft()));
    const notify = vi.fn(async () => undefined);
    const result = await runIssuePipeline({ ...deps, notify }, input);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ issueId: result.issueId, userId: 1, number: 1 });
    expect(issues.issues.get(result.issueId)?.status).toBe('ready');
  });

  it('keeps the issue ready when notify throws', async () => {
    const { deps, issues } = setup(() => JSON.stringify(validDraft()));
    const lines: string[] = [];
    const notify = vi.fn(async () => {
      throw new Error('telegram down');
    });
    const result = await runIssuePipeline({ ...deps, notify, log: (l) => lines.push(l) }, input);
    expect(issues.issues.get(result.issueId)?.status).toBe('ready');
    expect(lines.some((line) => line.includes('notify failed: telegram down'))).toBe(true);
  });

  it('does not notify a failed issue', async () => {
    const { deps } = setup(() => new Error('provider down'));
    const notify = vi.fn(async () => undefined);
    await expect(runIssuePipeline({ ...deps, notify }, input)).rejects.toThrow(IssueFailedError);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a transition from the wrong state', async () => {
    const { issues } = setup(() => '{}');
    const record = await issues.create(1, { start: now, end: now });
    await expect(issues.transition(record.id, 'digesting', 'composing')).rejects.toThrow(
      /not in status/,
    );
  });
});

describe('executeIssueRun', () => {
  const claim = async (deps: PipelineDeps, issues: ReturnType<typeof setup>['issues']) => {
    const period = await planIssuePeriod(deps, { userId: 1, maxDays: 1 });
    const record = await issues.create(1, period);
    return newIssueRun(deps, { issueId: record.id, userId: 1, period, interests: null });
  };

  it('matches runIssuePipeline for a pre-created issue', async () => {
    const a = setup(() => JSON.stringify(validDraft()));
    const viaPipeline = await runIssuePipeline(a.deps, input);
    const b = setup(() => JSON.stringify(validDraft()));
    const viaExecute = await executeIssueRun(b.deps, await claim(b.deps, b.issues));

    expect(viaExecute.number).toBe(viaPipeline.number);
    expect(viaExecute.content).toEqual(viaPipeline.content);
    expect(viaExecute.stats).toEqual(viaPipeline.stats);
    expect(b.issues.issues.get(viaExecute.issueId)?.history).toEqual(
      a.issues.issues.get(viaPipeline.issueId)?.history,
    );
  });

  it('fails as timeout between steps once the deadline passed', async () => {
    const { deps, issues, smart } = setup(() => JSON.stringify(validDraft()));
    let clock = now.getTime();
    const ticking = { ...deps, now: () => new Date((clock += 1000)) };
    const run = await claim(ticking, issues);
    const deadline = new Date(clock + 2500);

    const error = await executeIssueRun(ticking, run, { deadline }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IssueFailedError);
    expect((error as Error).message).toMatch(/^timeout:/);
    const record = issues.issues.get(run.issueId);
    expect(record?.status).toBe('failed');
    expect(record?.error).toMatch(/^timeout:/);
    expect(smart.model.doGenerateCalls).toHaveLength(0);
  });

  it('stops digesting mid-way at the deadline', async () => {
    const { deps, issues } = setup(() => JSON.stringify(validDraft()));
    const run = await claim(deps, issues);
    let calls = 0;
    // Deadline passes after collect, while digest tasks remain.
    const timed = {
      ...deps,
      now: () => {
        calls += 1;
        return new Date(now.getTime() + (calls > 3 ? 10_000 : 0));
      },
    };
    const error = await executeIssueRun(timed, run, {
      deadline: new Date(now.getTime() + 5000),
    }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^timeout:/);
    expect(issues.issues.get(run.issueId)?.history).toContain('digesting');
    expect(issues.issues.get(run.issueId)?.history).not.toContain('composing');
  });

  describe('compose reserve', () => {
    // 2 channels x 2 MSK days = 4 digest tasks; each finished task moves the clock by 50s.
    const budgeted = async (deadlineInMs: number) => {
      const { deps, issues, digests, smart } = setup(() => JSON.stringify(validDraft()));
      let clock = now.getTime();
      const timed: PipelineDeps = { ...deps, now: () => new Date(clock), digestConcurrency: 1 };
      vi.spyOn(issues, 'progress').mockImplementation(async () => {
        clock += 50_000;
      });
      const post = (id: number) => ({
        id,
        tgPostId: id,
        text: `Пост ${id}`,
        publishedAt: new Date('2026-11-14T18:00:00Z'),
      });
      digests.posts.set(1, [post(301)]);
      digests.posts.set(2, [post(302)]);
      const run = await claim(timed, issues);
      const deadline = new Date(clock + deadlineInMs);
      const error = await executeIssueRun(timed, run, { deadline }).catch((e: unknown) => e);
      return { error, issues, digests, smart, run };
    };

    it('stops scheduling digests once only the reserve is left; finished ones stay cached', async () => {
      expect(COMPOSE_RESERVE_MS).toBe(60_000);
      // Cutoff at +120s: tasks start at 0, 50, 100; the 4th (150) is never started.
      const { error, issues, digests, smart, run } = await budgeted(180_000);
      expect((error as Error).message).toMatch(/^timeout:/);
      const record = issues.issues.get(run.issueId);
      expect(record?.status).toBe('failed');
      expect(record?.history).not.toContain('composing');
      expect(smart.model.doGenerateCalls).toHaveLength(0);
      expect(digests.digests.get('1:2026-11-14')).toBeDefined();
      expect(digests.digests.get('2:2026-11-14')).toBeDefined();
    });

    it('does not start compose with less than the reserve left', async () => {
      // Cutoff at +170s: all 4 tasks start (last at 150) and end at 200, past the cutoff.
      const { error, issues, smart, run } = await budgeted(230_000);
      expect((error as Error).message).toMatch(/^timeout:/);
      expect(issues.issues.get(run.issueId)?.history).not.toContain('composing');
      expect(smart.model.doGenerateCalls).toHaveLength(0);
    });

    it('composes when the reserve is still there', async () => {
      const { error, issues, run } = await budgeted(300_000);
      expect(error).not.toBeInstanceOf(Error);
      expect(issues.issues.get(run.issueId)?.status).toBe('ready');
    });
  });

  it('skips notify when notifyAllowed is false', async () => {
    const { deps, issues } = setup(() => JSON.stringify(validDraft()));
    const notify = vi.fn(async () => undefined);
    const result = await executeIssueRun({ ...deps, notify }, await claim(deps, issues), {
      notifyAllowed: false,
    });
    expect(issues.issues.get(result.issueId)?.status).toBe('ready');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('planIssuePeriod', () => {
  it('re-covers the period of a soft-deleted issue (owner decision)', async () => {
    const { deps, issues } = setup(() => '{}');
    const hour = 3_600_000;
    const add = async (endOffsetH: number) => {
      const end = new Date(now.getTime() - endOffsetH * hour);
      const record = await issues.create(1, { start: new Date(end.getTime() - 24 * hour), end });
      const row = issues.issues.get(record.id);
      if (row === undefined) throw new Error('no record');
      row.status = 'ready';
      return row;
    };
    const older = await add(6);
    const newer = await add(2);

    expect((await planIssuePeriod(deps, { userId: 1, maxDays: 1 })).start).toEqual(newer.periodEnd);
    newer.deletedAt = now;
    expect((await planIssuePeriod(deps, { userId: 1, maxDays: 1 })).start).toEqual(older.periodEnd);
    older.deletedAt = now;
    const fresh = await planIssuePeriod(deps, { userId: 1, maxDays: 1 });
    expect(fresh.start).toEqual(new Date(now.getTime() - 24 * hour));
  });

  it('always continues from the last ready issue, capped at maxDays + grace', async () => {
    const { deps, issues } = setup(() => '{}');
    const hour = 3_600_000;
    const end = new Date(now.getTime() - 100 * hour);
    const record = await issues.create(1, { start: new Date(end.getTime() - 24 * hour), end });
    const row = issues.issues.get(record.id);
    if (row === undefined) throw new Error('no record');
    row.status = 'ready';

    // 100h ago: within a weekly window, beyond a daily or 3-day one.
    expect((await planIssuePeriod(deps, { userId: 1, maxDays: 7 })).start).toEqual(end);
    expect((await planIssuePeriod(deps, { userId: 1, maxDays: 3 })).start).toEqual(
      new Date(now.getTime() - 72 * hour),
    );
    expect((await planIssuePeriod(deps, { userId: 1, maxDays: 1 })).start).toEqual(
      new Date(now.getTime() - 24 * hour),
    );
  });
});

describe('LLM rate limits', () => {
  const rateLimit = (quotaId: string, retryDelay = '7s') =>
    new APICallError({
      message: 'You exceeded your current quota.',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          code: 429,
          message: 'You exceeded your current quota.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
          ],
        },
      }),
      isRetryable: false,
    });
  const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
  const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';

  /** Channels 1..n each get one post on 2026-11-14, so every channel needs a digest call. */
  const withPosts = (
    deps: PipelineDeps,
    digests: ReturnType<typeof setup>['digests'],
    n: number,
  ) => {
    const many = Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      username: `ch${i + 1}`,
      title: null,
    }));
    (deps.issues as ReturnType<typeof setup>['issues']).channels = many;
    for (const channel of many) {
      digests.posts.set(channel.id, [
        {
          id: 300 + channel.id,
          tgPostId: 300 + channel.id,
          text: `Пост ${channel.id}`,
          publishedAt: new Date('2026-11-14T18:00:00Z'),
        },
      ]);
    }
  };

  const tracked = () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const model = new MockLanguageModelV4({
      modelId: 'fast',
      doGenerate: async (options) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const id = Number(/<post id="(\d+)"/.exec(promptText(options))?.[1]);
        return textResult(
          JSON.stringify({
            items: [{ title: 'T', summary: 'S', importance: 3, topics: [], postIds: [id] }],
          }),
        );
      },
    });
    return { model, max: () => maxInFlight };
  };

  it('llm.concurrency = 1 (LLM_CONCURRENCY=1) runs digests strictly one at a time', async () => {
    const { deps, digests } = setup(() => JSON.stringify(validDraft()));
    withPosts(deps, digests, 4);
    const fast = tracked();
    deps.llm = {
      ...deps.llm,
      fast: { model: fast.model, id: 'fast', providerOptions: {} },
      concurrency: 1,
    };
    await runIssuePipeline(deps, input).catch(() => undefined);
    expect(fast.model.doGenerateCalls.length).toBe(4);
    expect(fast.max()).toBe(1);
  });

  it('defaults to 3 parallel digests without llm.concurrency', async () => {
    const { deps, digests } = setup(() => JSON.stringify(validDraft()));
    withPosts(deps, digests, 4);
    const fast = tracked();
    deps.llm = { ...deps.llm, fast: { model: fast.model, id: 'fast', providerOptions: {} } };
    await runIssuePipeline(deps, input).catch(() => undefined);
    expect(fast.max()).toBe(3);
  });

  it('a daily quota in a digest fails the issue as llm_quota and stops further calls', async () => {
    const { deps, digests, issues, smart } = setup(() => JSON.stringify(validDraft()));
    withPosts(deps, digests, 6);
    deps.digestConcurrency = 1;
    const fast = mockStage('fast', () => rateLimit(PER_DAY));
    deps.llm = { ...deps.llm, fast: fast.stage };

    const error = await runIssuePipeline(deps, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IssueFailedError);
    expect((error as Error).message).toMatch(/^llm_quota:/);
    expect([...issues.issues.values()][0]?.error).toMatch(/^llm_quota:/);
    expect(fast.model.doGenerateCalls).toHaveLength(1);
    expect(smart.model.doGenerateCalls).toHaveLength(0);
  });

  it('a daily quota in compose fails the issue as llm_quota', async () => {
    const { deps, issues, smart } = setup(() => rateLimit(PER_DAY));
    const error = await runIssuePipeline(deps, input).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^llm_quota:/);
    expect([...issues.issues.values()][0]?.error).toMatch(/^llm_quota:/);
    expect(smart.model.doGenerateCalls).toHaveLength(1);
  });

  const claimed = async (deps: PipelineDeps, issues: ReturnType<typeof setup>['issues']) => {
    const period = await planIssuePeriod(deps, { userId: 1, maxDays: 1 });
    const record = await issues.create(1, period);
    return newIssueRun(deps, { issueId: record.id, userId: 1, period, interests: null });
  };

  it('a compose 429 is not retried when the new call would not fit before the deadline', async () => {
    expect(COMPOSE_MIN_ATTEMPT_MS).toBe(30_000);
    const { deps, issues, smart } = setup(() => rateLimit(PER_MINUTE, '7s'));
    const run = await claimed(deps, issues);
    // 20s left at compose: the 7s wait fits, but 7s + 30s for the new smart call does not.
    const started = Date.now();
    const error = await executeIssueRun(deps, run, {
      deadline: new Date(now.getTime() + 20_000),
      composeReserveMs: 10_000,
    }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(IssueFailedError);
    expect((error as Error).message).toContain('exceeded your current quota');
    expect(issues.issues.get(run.issueId)?.status).toBe('failed');
    expect(smart.model.doGenerateCalls).toHaveLength(1);
  });

  it('a digest 429 is not retried into the compose reserve', async () => {
    expect(DIGEST_MIN_ATTEMPT_MS).toBe(15_000);
    const { deps, digests, issues } = setup(() => JSON.stringify(validDraft()));
    withPosts(deps, digests, 1);
    const fast = mockStage('fast', () => rateLimit(PER_MINUTE, '7s'));
    deps.llm = { ...deps.llm, fast: fast.stage };
    const run = await claimed(deps, issues);
    // Compose cutoff 20s away: 7s wait + 15s digest budget does not fit.
    const started = Date.now();
    await executeIssueRun(deps, run, {
      deadline: new Date(now.getTime() + 20_000 + COMPOSE_RESERVE_MS),
    }).catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fast.model.doGenerateCalls).toHaveLength(1);
    expect(run.stats.digests.failed).toBe(1);
  });

  it('a digest 429 is retried when wait + digest budget fit before the compose cutoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { deps, digests, issues } = setup(() => JSON.stringify(validDraft()));
      withPosts(deps, digests, 1);
      let call = 0;
      const fast = mockStage('fast', (prompt) => {
        call += 1;
        if (call === 1) return rateLimit(PER_MINUTE, '7s');
        const id = Number(/<post id="(\d+)"/.exec(prompt)?.[1]);
        return JSON.stringify({
          items: [{ title: 'T', summary: 'S', importance: 3, topics: [], postIds: [id] }],
        });
      });
      deps.llm = { ...deps.llm, fast: fast.stage };
      const run = await claimed(deps, issues);
      const result = executeIssueRun(deps, run, {
        deadline: new Date(now.getTime() + 30_000 + COMPOSE_RESERVE_MS),
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(8_000);
      await result;
      expect(fast.model.doGenerateCalls).toHaveLength(2);
      expect(run.stats.digests.failed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a per-minute 429 in compose is retried after retryDelay within the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { deps } = setup(
        (() => {
          let call = 0;
          return () => (++call === 1 ? rateLimit(PER_MINUTE, '7s') : JSON.stringify(validDraft()));
        })(),
      );
      const result = runIssuePipeline(deps, input);
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(result).resolves.toMatchObject({ number: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
