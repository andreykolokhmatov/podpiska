import { describe, expect, it, vi } from 'vitest';

import type { IssueReadyNotice, NotifyOutcome } from '@/bot/notify';
import { EnvError, type CronEnv } from '@/lib/env';
import type { ClaimInput, ClaimResult } from '@/miniapp/store';
import { seedStores, validDraft } from '@/pipeline/__fixtures__/compose-fixtures';
import { mockStage } from '@/pipeline/__fixtures__/fakes';
import type { PipelineDeps } from '@/pipeline/run';

import { bearerMatches, createCronApi, type CronApiDeps } from './api';
import type { RecentIssue, ScheduleStore, ScheduleUser } from './store';

const SECRET = 's'.repeat(64);
const APP_URL = 'https://podpiska.example';
const HOUR = 3_600_000;
// 08:07 MSK on 15 November; the daily 08:00 slot is due.
const now = new Date('2026-11-15T05:07:00Z');
const SLOT = new Date('2026-11-15T05:00:00Z');

class FakeScheduleStore implements ScheduleStore {
  users = new Map<number, ScheduleUser & { blocked: boolean; channels: number }>();
  recent = new Map<number, RecentIssue[]>();
  attempts = 0;
  calls: string[] = [];

  addUser(id: number, patch: Partial<ScheduleUser & { blocked: boolean; channels: number }> = {}) {
    this.users.set(id, {
      id,
      interests: 'экономика',
      enabled: true,
      everyDays: 1,
      hour: 8,
      timeZone: 'Europe/Moscow',
      nextIssueAt: SLOT,
      pausedAt: null,
      canNotifyAt: new Date('2026-11-01T00:00:00Z'),
      blocked: false,
      channels: 2,
      ...patch,
    });
  }
  private user(id: number) {
    const user = this.users.get(id);
    if (user === undefined) throw new Error(`no user ${id}`);
    return user;
  }
  private mayRun(user: ScheduleUser & { blocked: boolean }) {
    return user.enabled && user.pausedAt === null && user.canNotifyAt !== null && !user.blocked;
  }
  async get(id: number) {
    return this.users.get(id);
  }
  async update() {
    throw new Error('not used');
  }
  async setTimezone() {
    throw new Error('not used');
  }
  async activate() {
    return false;
  }
  async dueUsers(at: Date, limit: number) {
    return [...this.users.values()]
      .filter((u) => u.nextIssueAt !== null && u.nextIssueAt <= at)
      .filter((u) => this.mayRun(u) && u.channels > 0)
      .sort((a, b) => (a.nextIssueAt?.getTime() ?? 0) - (b.nextIssueAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((u) => u.id);
  }
  async claimSlot(
    id: number,
    at: Date,
    next: (user: ScheduleUser & { nextIssueAt: Date }) => Date,
  ) {
    const user = this.users.get(id);
    if (user?.nextIssueAt == null || user.nextIssueAt > at || !this.mayRun(user)) return undefined;
    const slot = user.nextIssueAt;
    const claimed = next({ ...user, nextIssueAt: slot });
    user.nextIssueAt = claimed;
    this.calls.push('claimSlot');
    return { user: { ...user }, slot, next: claimed };
  }
  async rollbackSlot(id: number, slot: Date, claimed: Date) {
    this.calls.push('rollbackSlot');
    const user = this.user(id);
    if (user.nextIssueAt?.getTime() === claimed.getTime()) user.nextIssueAt = slot;
  }
  async retrySoon(id: number, at: Date) {
    this.calls.push('retrySoon');
    const user = this.user(id);
    if (user.nextIssueAt !== null && this.mayRun(user) && at < user.nextIssueAt) {
      user.nextIssueAt = at;
    }
  }
  async recentReady(id: number, limit: number) {
    return (this.recent.get(id) ?? []).slice(0, limit);
  }
  async pause(id: number, at: Date) {
    const user = this.user(id);
    if (user.pausedAt !== null) return false;
    user.pausedAt = at;
    return true;
  }
  async countSlotAttempts() {
    return this.attempts;
  }
  async markUnreachable(id: number, at: Date) {
    const user = this.user(id);
    user.canNotifyAt = null;
    user.pausedAt ??= at;
  }
}

type Outcome = 'ready' | 'no_posts' | 'timeout';

const setup = (opts: { outcome?: Outcome; env?: Partial<CronEnv>; envError?: boolean } = {}) => {
  const store = new FakeScheduleStore();
  const { digests, issues } = seedStores();
  if (opts.outcome === 'no_posts') issues.counts = { messages: 0, channels: 0 };
  // The seeded posts are from later that day; move them inside the window ending now.
  issues.postsMeta = issues.postsMeta.map((meta) => ({
    ...meta,
    publishedAt: new Date(meta.publishedAt.getTime() - 4 * HOUR),
  }));
  const pipelineDeps: PipelineDeps = {
    issues,
    digests,
    collect: async (names) =>
      names.map((username) => ({ username, ok: true, collected: 1, inserted: 0 })),
    llm: {
      fast: mockStage('fast', () => JSON.stringify({ items: [] })).stage,
      smart: mockStage('smart', () => JSON.stringify(validDraft())).stage,
    },
    // Past the deadline from the first check: the build fails as a timeout.
    now: () => (opts.outcome === 'timeout' ? new Date(now.getTime() + HOUR) : now),
  };
  const claimIssue = vi.fn(async (input: ClaimInput): Promise<ClaimResult> => {
    const record = await issues.create(input.userId, input.period);
    return {
      kind: 'started',
      used: 0,
      issue: {
        id: record.id,
        status: 'pending',
        error: null,
        number: null,
        digestsDone: 0,
        digestsTotal: 0,
        createdAt: now,
      },
    };
  });
  const tasks: (() => Promise<void>)[] = [];
  const lines: string[] = [];
  const notifyReady = vi.fn<(notice: IssueReadyNotice) => Promise<NotifyOutcome>>(
    async () => 'sent',
  );
  const sendPaused = vi.fn<(userId: number) => Promise<NotifyOutcome>>(async () => 'sent');
  const env: CronEnv = {
    CRON_SECRET: SECRET,
    APP_URL,
    TELEGRAM_BOT_TOKEN: '1:x',
    MAX_BUILDS_PER_DAY_GLOBAL: 30,
    ...opts.env,
  };
  const deps: CronApiDeps = {
    env: () => {
      if (opts.envError) throw new EnvError('Invalid environment variables:\n  - CRON_SECRET: x');
      return env;
    },
    now: () => now,
    store,
    claimIssue,
    pipeline: () => pipelineDeps,
    notifyReady,
    sendPaused,
    fetch: vi.fn(async () => new Response(null, { status: 202 })),
    after: (task) => tasks.push(task),
    log: (line) => lines.push(line),
  };
  const api = createCronApi(deps);
  return { api, deps, store, issues, claimIssue, tasks, lines, notifyReady, sendPaused };
};

const post = (path: string, body?: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  new Request(`${APP_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth === null ? {} : { authorization: auth }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const run = (api: ReturnType<typeof setup>['api'], userId = 1) =>
  api.run(post('/api/cron/run', { userId }));

describe('auth', () => {
  it.each([
    ['missing', null],
    ['wrong secret', `Bearer ${'x'.repeat(64)}`],
    ['wrong scheme', `Basic ${SECRET}`],
    ['secret prefix', `Bearer ${SECRET.slice(0, 32)}`],
  ])('answers 401 when the bearer is %s', async (_, auth) => {
    const { api, store, claimIssue } = setup();
    store.addUser(1);
    for (const res of [
      await api.tick(post('/api/cron/tick', undefined, auth)),
      await api.run(post('/api/cron/run', { userId: 1 }, auth)),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(store.calls).toEqual([]);
    expect(claimIssue).not.toHaveBeenCalled();
  });

  it('answers 500 (never open) when the env is invalid', async () => {
    const { api } = setup({ envError: true });
    expect((await api.tick(post('/api/cron/tick'))).status).toBe(500);
    expect((await run(api)).status).toBe(500);
  });

  it('bearerMatches refuses an empty secret', () => {
    expect(bearerMatches('Bearer x', '')).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects a malformed run body', async () => {
    const { api } = setup();
    for (const body of [{}, { userId: 'a' }, { userId: -1 }, { userId: 1.5 }]) {
      expect((await api.run(post('/api/cron/run', body))).status).toBe(400);
    }
  });
});

describe('tick', () => {
  it('fans out one run per due user, at most 10, 3 at a time', async () => {
    const { api, deps, store } = setup();
    for (let id = 1; id <= 12; id += 1) {
      store.addUser(id, { nextIssueAt: new Date(SLOT.getTime() - id * 60_000) });
    }
    store.addUser(20, { nextIssueAt: new Date(now.getTime() + HOUR) });
    store.addUser(21, { pausedAt: now });
    store.addUser(22, { canNotifyAt: null });
    store.addUser(23, { channels: 0 });
    store.addUser(24, { blocked: true });
    let inFlight = 0;
    let peak = 0;
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(null, { status: 202 });
    });
    deps.fetch = fetch;
    const res = await api.tick(post('/api/cron/tick'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ due: 10, started: 10, skipped: 0 });
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(3);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${APP_URL}/api/cron/run`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    // Oldest slot first.
    expect(JSON.parse(String(init.body))).toEqual({ userId: 12 });
  });

  it('a single failing run does not abort the tick', async () => {
    const { api, deps, store, lines } = setup();
    for (let id = 1; id <= 4; id += 1) store.addUser(id);
    let call = 0;
    deps.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('connect ECONNREFUSED');
      if (call === 2) return new Response(null, { status: 500 });
      if (call === 3) return Response.json({ status: 'skipped' });
      return new Response(null, { status: 202 });
    });
    const res = await api.tick(post('/api/cron/tick'));
    expect(await res.json()).toEqual({ due: 4, started: 1, skipped: 3 });
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('run', () => {
  it('claims the slot once under a double tick', async () => {
    const { api, store, claimIssue } = setup();
    store.addUser(1);
    const [a, b] = await Promise.all([run(api), run(api)]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(claimIssue).toHaveBeenCalledTimes(1);
    expect(claimIssue.mock.calls[0]?.[0]).toMatchObject({
      trigger: 'scheduled',
      perUserLimit: null,
      globalLimit: 30,
    });
    // Advanced from the old slot: tomorrow 08:00 MSK.
    expect(store.users.get(1)?.nextIssueAt?.toISOString()).toBe('2026-11-16T05:00:00.000Z');
  });

  it('skips a user who is not due', async () => {
    const { api, store, claimIssue } = setup();
    store.addUser(1, { nextIssueAt: new Date(now.getTime() + HOUR) });
    const res = await run(api);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'skipped', reason: 'not_due' });
    expect(claimIssue).not.toHaveBeenCalled();
  });

  it('pauses after 3 unread scheduled issues and tells the user once', async () => {
    const { api, store, claimIssue, sendPaused } = setup();
    store.addUser(1);
    const unread: RecentIssue = { trigger: 'scheduled', openedAt: null, periodEnd: SLOT };
    store.recent.set(1, [unread, unread, unread]);

    const res = await run(api);
    expect(await res.json()).toEqual({ status: 'skipped', reason: 'paused' });
    expect(store.users.get(1)?.pausedAt).toEqual(now);
    expect(sendPaused).toHaveBeenCalledTimes(1);
    expect(sendPaused).toHaveBeenCalledWith(1);
    expect(claimIssue).not.toHaveBeenCalled();

    // Paused users are never due again; even a forced run sends nothing more.
    store.users.get(1)!.nextIssueAt = SLOT;
    store.users.get(1)!.pausedAt = null;
    await store.pause(1, now);
    await run(api);
    expect(sendPaused).toHaveBeenCalledTimes(1);
  });

  it('does not pause when one of the last 3 was opened or built manually', async () => {
    const { api, store, sendPaused } = setup();
    store.addUser(1);
    const old = new Date(now.getTime() - 50 * HOUR);
    const unread: RecentIssue = { trigger: 'scheduled', openedAt: null, periodEnd: old };
    store.recent.set(1, [{ ...unread, trigger: 'manual' }, unread, unread]);
    expect((await run(api)).status).toBe(202);
    expect(sendPaused).not.toHaveBeenCalled();
  });

  it('skips when a manual build just covered the window; the slot stays advanced', async () => {
    const { api, store, claimIssue } = setup();
    store.addUser(1);
    store.recent.set(1, [
      { trigger: 'manual', openedAt: now, periodEnd: new Date(now.getTime() - 2 * HOUR) },
    ]);
    const res = await run(api);
    expect(await res.json()).toEqual({ status: 'skipped', reason: 'fresh' });
    expect(claimIssue).not.toHaveBeenCalled();
    expect(store.users.get(1)?.nextIssueAt?.toISOString()).toBe('2026-11-16T05:00:00.000Z');
  });

  it('gives the slot back when busy or over the global cap', async () => {
    for (const kind of ['busy', 'limit_global'] as const) {
      const { api, store, claimIssue, tasks } = setup();
      store.addUser(1);
      claimIssue.mockImplementationOnce(async () =>
        kind === 'busy'
          ? {
              kind,
              issue: {
                id: 'x',
                status: 'collecting',
                error: null,
                number: null,
                digestsDone: 0,
                digestsTotal: 0,
                createdAt: now,
              },
            }
          : { kind },
      );
      const res = await run(api);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'skipped', reason: kind });
      expect(store.users.get(1)?.nextIssueAt).toEqual(SLOT);
      expect(tasks).toHaveLength(0);
    }
  });

  it('builds in after() and notifies when ready', async () => {
    const { api, store, issues, tasks, notifyReady, claimIssue } = setup({ outcome: 'ready' });
    store.addUser(1);
    const res = await run(api);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; issueId: string };
    expect(body.status).toBe('started');
    expect(tasks).toHaveLength(1);
    expect(claimIssue.mock.calls[0]?.[0].period.start).toEqual(new Date(now.getTime() - 24 * HOUR));
    await tasks[0]?.();
    expect(issues.issues.get(body.issueId)?.status).toBe('ready');
    expect(notifyReady).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: body.issueId, userId: 1, number: 1 }),
    );
    expect(store.calls).not.toContain('retrySoon');
  });

  it('stays silent on an empty period', async () => {
    const { api, store, issues, tasks, notifyReady } = setup({ outcome: 'no_posts' });
    store.addUser(1);
    const body = (await (await run(api)).json()) as { issueId: string };
    await tasks[0]?.();
    expect(issues.issues.get(body.issueId)?.error).toMatch(/^no_posts/);
    expect(notifyReady).not.toHaveBeenCalled();
    expect(store.calls).not.toContain('retrySoon');
    expect(store.users.get(1)?.nextIssueAt?.toISOString()).toBe('2026-11-16T05:00:00.000Z');
  });

  it('retries a failed build an hour later, at most 3 attempts per slot', async () => {
    const { api, store, tasks } = setup({ outcome: 'timeout' });
    store.addUser(1);
    store.attempts = 1;
    await run(api);
    await tasks[0]?.();
    expect(store.users.get(1)?.nextIssueAt).toEqual(new Date(now.getTime() + HOUR));

    const capped = setup({ outcome: 'timeout' });
    capped.store.addUser(1);
    capped.store.attempts = 3;
    await run(capped.api);
    await capped.tasks[0]?.();
    expect(capped.store.calls).not.toContain('retrySoon');
    expect(capped.store.users.get(1)?.nextIssueAt?.toISOString()).toBe('2026-11-16T05:00:00.000Z');
  });

  it('an unreachable user loses can_notify and is paused', async () => {
    const { api, store, tasks, notifyReady } = setup({ outcome: 'ready' });
    store.addUser(1);
    notifyReady.mockResolvedValueOnce('unreachable');
    await run(api);
    await tasks[0]?.();
    expect(store.users.get(1)).toMatchObject({ canNotifyAt: null, pausedAt: now });
  });

  it('answers 500 before moving the slot when the LLM env is invalid', async () => {
    const { api, deps, store } = setup();
    store.addUser(1);
    deps.pipeline = () => {
      throw new EnvError('Invalid environment variables:\n  - GOOGLE_GENERATIVE_AI_API_KEY: x');
    };
    expect((await run(api)).status).toBe(500);
    expect(store.users.get(1)?.nextIssueAt).toEqual(SLOT);
  });
});
