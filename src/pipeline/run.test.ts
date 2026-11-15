import { APICallError } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { CollectResult } from '@/collector';

import { now, seedStores, validDraft } from './__fixtures__/compose-fixtures';
import { mockStage } from './__fixtures__/fakes';
import { COMPOSE_PROMPT_VERSION, DIGEST_PROMPT_VERSION } from './prompts';
import {
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

const input = { userId: 1, days: 1, interests: null };

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
    const period = await planIssuePeriod(deps, { userId: 1, days: 1 });
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

    expect((await planIssuePeriod(deps, { userId: 1, days: 1 })).start).toEqual(newer.periodEnd);
    newer.deletedAt = now;
    expect((await planIssuePeriod(deps, { userId: 1, days: 1 })).start).toEqual(older.periodEnd);
    older.deletedAt = now;
    const fresh = await planIssuePeriod(deps, { userId: 1, days: 1 });
    expect(fresh.start).toEqual(new Date(now.getTime() - 24 * hour));
  });
});
