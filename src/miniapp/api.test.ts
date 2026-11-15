import { sign } from '@tma.js/init-data-node';
import { describe, expect, it, vi } from 'vitest';

import { AddChannelError, type AddChannelResult, type UserChannelView } from '@/channels';
import { EnvError, type MiniAppEnv } from '@/lib/env';
import { seedStores, validDraft } from '@/pipeline/__fixtures__/compose-fixtures';
import { mockStage } from '@/pipeline/__fixtures__/fakes';
import type { PipelineDeps } from '@/pipeline/run';
import type { RecentIssue, ScheduleStore, ScheduleUser } from '@/schedule/store';

import { cleanInterests, createAppApi, type AppApiDeps, type ShareRequest } from './api';
import {
  addChannelResponseSchema,
  apiErrorSchema,
  buildResponseSchema,
  channelsResponseSchema,
  deleteIssueResponseSchema,
  interestsResponseSchema,
  issueResponseSchema,
  issuesResponseSchema,
  meResponseSchema,
  pdfLinkResponseSchema,
  scheduleResponseSchema,
  shareIssueResponseSchema,
} from './contract';
import { countsTowardQuota, isInFlight, type IssueStateRow } from './status';
import type { AppStore, AppUser, ClaimInput, ClaimResult, ReadyIssueRow } from './store';

const PROD = '111111:prod-token';
const DEV = '222222:dev-token';
const OWNER = 900;
const now = new Date('2026-11-15T12:00:00Z');
const UUID = (n: number) => `0b1c2d3e-0000-4000-8000-${String(n).padStart(12, '0')}`;

const initData = (
  opts: { id?: number; token?: string; write?: boolean; authDate?: Date } = {},
): string =>
  sign(
    {
      user: {
        id: opts.id ?? 42,
        first_name: 'Андрей',
        username: 'andrey',
        allows_write_to_pm: opts.write ?? true,
      },
    },
    opts.token ?? PROD,
    opts.authDate ?? new Date(now.getTime() - 60_000),
  );

interface IssueRow extends IssueStateRow {
  userId: number;
  contentJson: unknown;
  deletedAt: Date | null;
  trigger: 'manual' | 'scheduled';
  periodEnd: Date;
  openedAt: Date | null;
}

class FakeAppStore implements AppStore {
  users = new Map<number, AppUser>();
  channels = new Map<number, UserChannelView[]>();
  issues: IssueRow[] = [];
  claims: ClaimInput[] = [];
  getIssueCalls = 0;
  opened: string[] = [];
  private seq = 0;

  async upsertUser(
    user: { id: number; firstName: string; username: string | null },
    options: { canNotifyAt?: Date } = {},
  ) {
    let found = [...this.users.values()].find((u) => u.telegramId === user.id);
    if (found === undefined) {
      const id = this.users.size + 1;
      found = {
        id,
        telegramId: user.id,
        firstName: user.firstName,
        username: user.username,
        onboardedAt: null,
        interests: null,
        schedule: {
          id,
          interests: null,
          enabled: true,
          everyDays: 1,
          hour: 8,
          timeZone: null,
          nextIssueAt: null,
          pausedAt: null,
          canNotifyAt: null,
        },
      };
      this.users.set(id, found);
    }
    if (options.canNotifyAt !== undefined) found.schedule.canNotifyAt = options.canNotifyAt;
    return { ...found, schedule: { ...found.schedule } };
  }
  async markOpened(userId: number, id: string) {
    this.opened.push(id);
    const row = this.issues.find((i) => i.id === id && i.userId === userId);
    if (row?.status === 'ready' && row.deletedAt === null) row.openedAt ??= now;
  }
  async findUser(telegramId: number) {
    return [...this.users.values()].find((u) => u.telegramId === telegramId);
  }
  async markOnboarded(userId: number, at: Date) {
    const user = this.users.get(userId)!;
    user.onboardedAt ??= at;
    return user.onboardedAt;
  }
  async setInterests(userId: number, interests: string | null) {
    this.users.get(userId)!.interests = interests;
  }
  async countChannels(userId: number) {
    return (this.channels.get(userId) ?? []).length;
  }
  async listChannels(userId: number) {
    return this.channels.get(userId) ?? [];
  }
  async removeChannel(userId: number, username: string) {
    const list = this.channels.get(userId) ?? [];
    const kept = list.filter((c) => c.username !== username);
    this.channels.set(userId, kept);
    return kept.length < list.length;
  }
  async listReadyIssues(userId: number, page: { limit: number; before?: number }) {
    return this.issues
      .filter((i) => i.userId === userId && i.status === 'ready' && i.number !== null)
      .filter((i) => i.deletedAt === null)
      .filter((i) => page.before === undefined || (i.number ?? 0) < page.before)
      .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
      .slice(0, page.limit)
      .map((i): ReadyIssueRow => ({
        id: i.id,
        number: i.number ?? 0,
        createdAt: i.createdAt,
        contentJson: i.contentJson,
      }));
  }
  async latestInFlight(userId: number) {
    return this.issues.filter((i) => i.userId === userId && isInFlight(i.status)).at(-1);
  }
  async getIssue(userId: number, id: string) {
    this.getIssueCalls += 1;
    return this.issues.find((i) => i.id === id && i.userId === userId && i.deletedAt === null);
  }
  async getReadyIssue(userId: number, id: string) {
    this.getIssueCalls += 1;
    const row = this.issues.find(
      (i) => i.id === id && i.userId === userId && i.status === 'ready' && i.deletedAt === null,
    );
    if (row === undefined || row.number === null) return undefined;
    return {
      id: row.id,
      number: row.number,
      createdAt: row.createdAt,
      contentJson: row.contentJson,
    };
  }
  async softDeleteIssue(userId: number, id: string) {
    const row = this.issues.find((i) => i.id === id && i.userId === userId);
    if (row?.status === 'ready') {
      row.deletedAt ??= now;
      return 'deleted' as const;
    }
    return row !== undefined && isInFlight(row.status) ? ('busy' as const) : ('not_found' as const);
  }
  async countBuilds(userId: number, since: Date) {
    return this.issues.filter(
      (i) =>
        i.userId === userId &&
        i.trigger === 'manual' &&
        i.createdAt >= since &&
        countsTowardQuota(i),
    ).length;
  }
  async claimIssue(input: ClaimInput): Promise<ClaimResult> {
    this.claims.push(input);
    const mine = this.issues.filter((i) => i.userId === input.userId);
    const busy = mine.find((i) => isInFlight(i.status));
    if (busy) return { kind: 'busy', issue: busy };
    const used = await this.countBuilds(input.userId, input.since);
    if (input.perUserLimit !== null && used >= input.perUserLimit) return { kind: 'limit', used };
    const global = this.issues.filter((i) => i.createdAt >= input.since && countsTowardQuota(i));
    if (global.length >= input.globalLimit) return { kind: 'limit_global' };
    if ((await this.countChannels(input.userId)) === 0) return { kind: 'no_channels' };
    const issue = this.add(input.userId, { status: 'pending', trigger: input.trigger });
    return { kind: 'started', issue, used: input.perUserLimit === null ? 0 : used + 1 };
  }
  add(userId: number, patch: Partial<IssueRow> = {}): IssueRow {
    this.seq += 1;
    const row: IssueRow = {
      id: UUID(this.seq),
      userId,
      status: 'ready',
      error: null,
      number: null,
      digestsDone: 0,
      digestsTotal: 0,
      createdAt: now,
      contentJson: null,
      deletedAt: null,
      trigger: 'manual',
      periodEnd: now,
      openedAt: null,
      ...patch,
    };
    this.issues.push(row);
    return row;
  }
}

/** Schedule store over the fake app store's users and issues. */
class FakeScheduleStore implements Pick<
  ScheduleStore,
  'get' | 'update' | 'setTimezone' | 'activate' | 'recentReady'
> {
  updates: Parameters<ScheduleStore['update']>[] = [];
  constructor(private readonly app: FakeAppStore) {}
  private user(userId: number): ScheduleUser {
    const user = this.app.users.get(userId);
    if (user === undefined) throw new Error(`no user ${userId}`);
    return user.schedule;
  }
  async get(userId: number) {
    const user = this.app.users.get(userId);
    return user === undefined ? undefined : { ...user.schedule };
  }
  async update(userId: number, patch: Parameters<ScheduleStore['update']>[1]) {
    this.updates.push([userId, patch]);
    const user = this.user(userId);
    Object.assign(user, {
      enabled: patch.enabled,
      everyDays: patch.everyDays,
      hour: patch.hour,
      timeZone: patch.timeZone,
      nextIssueAt: patch.nextIssueAt,
    });
    if (patch.clearPause) user.pausedAt = null;
    if (patch.canNotifyAt !== undefined) user.canNotifyAt = patch.canNotifyAt;
  }
  async setTimezone(userId: number, timeZone: string) {
    this.user(userId).timeZone = timeZone;
  }
  async activate(userId: number, next: Date) {
    const user = this.user(userId);
    if (user.nextIssueAt !== null || !user.enabled || user.pausedAt !== null) return false;
    if (user.canNotifyAt === null) return false;
    user.nextIssueAt = next;
    return true;
  }
  async recentReady(userId: number, limit: number): Promise<RecentIssue[]> {
    return this.app.issues
      .filter((i) => i.userId === userId && i.status === 'ready' && i.deletedAt === null)
      .sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime())
      .slice(0, limit)
      .map((i) => ({ trigger: i.trigger, openedAt: i.openedAt, periodEnd: i.periodEnd }));
  }
}

const channel = (username: string): UserChannelView => ({
  username,
  title: username.toUpperCase(),
  avatarUrl: null,
  isAvailable: true,
});

const setup = (
  opts: {
    env?: Partial<MiniAppEnv>;
    pipeline?: () => PipelineDeps;
    addChannel?: AppApiDeps['addChannel'];
    share?: AppApiDeps['share'];
  } = {},
) => {
  const store = new FakeAppStore();
  const schedules = new FakeScheduleStore(store);
  const { digests, issues } = seedStores();
  const pipelineDeps: PipelineDeps = {
    issues,
    digests,
    collect: async () => [],
    llm: {
      fast: mockStage('fast', () => '{}').stage,
      smart: mockStage('smart', () => '{}').stage,
    },
    now: () => now,
  };
  const tasks: (() => Promise<void>)[] = [];
  const lines: string[] = [];
  const addChannel = vi.fn<AppApiDeps['addChannel']>(
    opts.addChannel ??
      (async (_userId, username): Promise<AddChannelResult> => ({
        status: 'added',
        channel: { username, displayUsername: username, title: 'T', avatarUrl: null },
      })),
  );
  const pipeline = vi.fn(opts.pipeline ?? (() => pipelineDeps));
  const share = vi.fn<AppApiDeps['share']>(opts.share ?? (async () => 'prepared-1'));
  const pdfLink = vi.fn<AppApiDeps['pdfLink']>(({ issueId, number }) => ({
    url: `https://podpiska.example/api/issues/${issueId}/pdf?exp=1&sig=x`,
    fileName: `Podpiska-${number}.pdf`,
  }));
  const env: MiniAppEnv = {
    TELEGRAM_BOT_TOKEN: PROD,
    TELEGRAM_DEV_BOT_TOKEN: DEV,
    OWNER_TELEGRAM_ID: OWNER,
    MAX_CHANNELS_PER_USER: 50,
    MAX_BUILDS_PER_DAY_GLOBAL: 30,
    ...opts.env,
  };
  const api = createAppApi({
    store,
    schedules,
    env: () => env,
    now: () => now,
    addChannel,
    pipeline,
    schedule: (task) => tasks.push(task),
    share,
    pdfLink,
    log: (line) => lines.push(line),
  });
  return {
    api,
    store,
    schedules,
    tasks,
    lines,
    addChannel,
    pipeline,
    share,
    pdfLink,
    pipelineDeps,
  };
};

const req = (
  method: string,
  path: string,
  opts: { auth?: string | null; body?: unknown; raw?: string } = {},
): Request => {
  const headers = new Headers({ 'content-type': 'application/json' });
  const auth = opts.auth === undefined ? `tma ${initData()}` : opts.auth;
  if (auth !== null) headers.set('authorization', auth);
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return new Request(`https://app.example${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

const errorOf = async (res: Response) => apiErrorSchema.parse(await res.json()).error;

describe('auth on every route', () => {
  const calls = (api: ReturnType<typeof setup>['api'], auth: string | null) => [
    api.me(req('GET', '/api/app/me', { auth })),
    api.onboarding(req('POST', '/api/app/onboarding', { auth })),
    api.listChannels(req('GET', '/api/app/channels', { auth })),
    api.addChannel(req('POST', '/api/app/channels', { auth, body: { input: '@a' } })),
    api.removeChannel(req('DELETE', '/api/app/channels', { auth, body: { username: 'a' } })),
    api.getInterests(req('GET', '/api/app/interests', { auth })),
    api.putInterests(req('PUT', '/api/app/interests', { auth, body: { interests: 'x' } })),
    api.listIssues(req('GET', '/api/app/issues', { auth })),
    api.buildIssue(req('POST', '/api/app/issues', { auth })),
    api.getIssue(req('GET', `/api/app/issues/${UUID(1)}`, { auth }), UUID(1)),
    api.deleteIssue(req('DELETE', `/api/app/issues/${UUID(1)}`, { auth }), UUID(1)),
    api.shareIssue(req('POST', `/api/app/issues/${UUID(1)}/share`, { auth }), UUID(1)),
    api.pdfLink(req('POST', `/api/app/issues/${UUID(1)}/pdf-link`, { auth }), UUID(1)),
    api.getSchedule(req('GET', '/api/app/schedule', { auth })),
    api.putSchedule(
      req('PUT', '/api/app/schedule', { auth, body: { enabled: true, everyDays: 1, hour: 8 } }),
    ),
  ];

  it.each([
    ['missing', null],
    ['wrong scheme', `Bearer ${initData()}`],
    ['bad signature', `tma ${initData({ token: '333:other' })}`],
  ])('answers 401 unauthorized when %s', async (_, auth) => {
    const { api, store } = setup();
    for (const res of await Promise.all(calls(api, auth))) {
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(await errorOf(res)).toBe('unauthorized');
    }
    expect(store.users.size).toBe(0);
  });

  it('answers 401 expired for initData older than 24h', async () => {
    const { api } = setup();
    const auth = `tma ${initData({ authDate: new Date(now.getTime() - 90_000_000) })}`;
    const res = await api.me(req('GET', '/api/app/me', { auth }));
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe('expired');
  });

  it('answers 500 misconfigured when the env is invalid', async () => {
    const store = new FakeAppStore();
    const api = createAppApi({
      store,
      schedules: new FakeScheduleStore(store),
      env: () => {
        throw new EnvError('Invalid environment variables:\n  - TELEGRAM_BOT_TOKEN: is required');
      },
      now: () => now,
      addChannel: vi.fn(),
      pipeline: vi.fn(),
      schedule: vi.fn(),
      share: vi.fn(),
      pdfLink: vi.fn(),
      log: vi.fn(),
    });
    const res = await api.me(req('GET', '/api/app/me'));
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('misconfigured');
  });

  it('never logs initData', async () => {
    const raw = initData();
    const { api, lines } = setup({
      pipeline: () => {
        throw new Error('boom');
      },
    });
    await api.buildIssue(req('POST', '/api/app/issues', { auth: `tma ${raw}` }));
    await api.me(req('GET', '/api/app/me', { auth: `tma ${raw}x` }));
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join('\n');
    expect(logged).not.toContain(raw.slice(0, 40));
    expect(logged).not.toContain('hash=');
  });
});

describe('me and onboarding', () => {
  it('upserts the user and reports the hub state', async () => {
    const { api } = setup();
    const res = await api.me(req('GET', '/api/app/me'));
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body).toEqual({
      user: { telegramId: 42, firstName: 'Андрей', username: 'andrey' },
      onboarded: false,
      owner: false,
      channels: { count: 0, limit: 50 },
      hasInterests: false,
      latestIssue: null,
      inFlight: null,
      quota: { limit: 3, used: 0, remaining: 3 },
      schedule: {
        enabled: true,
        everyDays: 1,
        hour: 8,
        timeZone: 'Europe/Moscow',
        nextIssueAt: null,
        paused: false,
        active: false,
        canNotify: true,
      },
    });
  });

  it('shows the latest ready issue and an in-flight build', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.add(1, {
      number: 4,
      contentJson: { masthead: { dateline: '15 ноября 2026' }, lead: { headline: 'Главное' } },
    });
    const building = store.add(1, { status: 'digesting', digestsDone: 1, digestsTotal: 3 });
    const body = meResponseSchema.parse(await (await api.me(req('GET', '/api/app/me'))).json());
    expect(body.latestIssue).toMatchObject({
      number: 4,
      dateline: '15 ноября 2026',
      headline: 'Главное',
    });
    expect(body.inFlight).toMatchObject({
      id: building.id,
      status: 'digesting',
      progress: { step: 'digesting', done: 1, total: 3 },
    });
    expect(body.quota).toEqual({ limit: 3, used: 2, remaining: 1 });
  });

  it('hides a stale in-flight build', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.add(1, { status: 'collecting', createdAt: new Date(now.getTime() - 400_000) });
    const body = meResponseSchema.parse(await (await api.me(req('GET', '/api/app/me'))).json());
    expect(body.inFlight).toBeNull();
  });

  it('marks onboarding once (idempotent)', async () => {
    const { api } = setup();
    const first = await (await api.onboarding(req('POST', '/api/app/onboarding'))).json();
    const second = await (await api.onboarding(req('POST', '/api/app/onboarding'))).json();
    expect(first).toEqual({ onboardedAt: now.toISOString() });
    expect(second).toEqual(first);
    const me = meResponseSchema.parse(await (await api.me(req('GET', '/api/app/me'))).json());
    expect(me.onboarded).toBe(true);
  });

  it('reports the owner only for prod-signed initData', async () => {
    const { api } = setup();
    const prod = `tma ${initData({ id: OWNER })}`;
    const dev = `tma ${initData({ id: OWNER, token: DEV })}`;
    const asProd = meResponseSchema.parse(
      await (await api.me(req('GET', '/', { auth: prod }))).json(),
    );
    const asDev = meResponseSchema.parse(
      await (await api.me(req('GET', '/', { auth: dev }))).json(),
    );
    expect(asProd).toMatchObject({ owner: true, quota: null });
    expect(asDev).toMatchObject({ owner: false, quota: { remaining: 3 } });
  });
});

describe('channels', () => {
  it('lists the user channels', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.channels.set(1, [channel('econnews')]);
    const body = channelsResponseSchema.parse(
      await (await api.listChannels(req('GET', '/api/app/channels'))).json(),
    );
    expect(body).toEqual({
      channels: [{ username: 'econnews', title: 'ECONNEWS', avatarUrl: null, available: true }],
      limit: 50,
    });
  });

  it('normalizes the input and adds the channel', async () => {
    const { api, addChannel } = setup();
    const res = await api.addChannel(
      req('POST', '/api/app/channels', { body: { input: 'https://t.me/TopOrLive' } }),
    );
    expect(res.status).toBe(201);
    expect(addChannelResponseSchema.parse(await res.json()).status).toBe('added');
    expect(addChannel).toHaveBeenCalledWith(1, 'toporlive', 50);
  });

  it('answers 200 for an existing subscription', async () => {
    const { api } = setup({
      addChannel: async (_u, username) => ({
        status: 'exists',
        channel: { username, displayUsername: username, title: null, avatarUrl: null },
      }),
    });
    const res = await api.addChannel(
      req('POST', '/api/app/channels', { body: { input: '@econnews' } }),
    );
    expect(res.status).toBe(200);
  });

  it('answers channel_limit with the limit', async () => {
    const { api } = setup({
      env: { MAX_CHANNELS_PER_USER: 2 },
      addChannel: async (_u, username) => ({
        status: 'limit',
        channel: { username, displayUsername: username, title: null, avatarUrl: null },
      }),
    });
    const res = await api.addChannel(
      req('POST', '/api/app/channels', { body: { input: '@econnews' } }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'channel_limit', limit: 2 });
  });

  it.each([
    ['private', 'channel_not_found', 'not_found'],
    ['retry_later', 'retry_later', 'retry_later'],
    ['invalid', 'invalid', 'invalid'],
    ['private', 'private', 'private'],
  ] as const)('maps add failure %s', async (_, code, reason) => {
    const { api } = setup({
      addChannel: async () => {
        throw new AddChannelError(reason);
      },
    });
    const res = await api.addChannel(
      req('POST', '/api/app/channels', { body: { input: '@econnews' } }),
    );
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe(code);
  });

  it('rejects unparsable and private input before any scrape', async () => {
    const { api, addChannel } = setup();
    const bad = await api.addChannel(
      req('POST', '/api/app/channels', { body: { input: 'a b c' } }),
    );
    expect(await errorOf(bad)).toBe('invalid');
    const invite = await api.addChannel(
      req('POST', '/api/app/channels', { body: { input: 'https://t.me/+AbCdEf123' } }),
    );
    expect(await errorOf(invite)).toBe('private');
    expect(addChannel).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized bodies', async () => {
    const { api } = setup();
    const notJson = await api.addChannel(req('POST', '/api/app/channels', { raw: '{' }));
    expect(notJson.status).toBe(400);
    const big = await api.addChannel(
      req('POST', '/api/app/channels', { raw: JSON.stringify({ input: 'x'.repeat(3000) }) }),
    );
    expect(big.status).toBe(413);
    expect(await errorOf(big)).toBe('bad_request');
  });

  it('removes a subscription and answers 404 for an unknown one', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.channels.set(1, [channel('econnews')]);
    const ok = await api.removeChannel(
      req('DELETE', '/api/app/channels', { body: { username: '@EconNews' } }),
    );
    expect(await ok.json()).toEqual({ ok: true });
    expect(store.channels.get(1)).toEqual([]);
    const missing = await api.removeChannel(
      req('DELETE', '/api/app/channels', { body: { username: 'econnews' } }),
    );
    expect(missing.status).toBe(404);
  });
});

describe('interests', () => {
  it('cleans, stores and returns the interests', async () => {
    const { api, store } = setup();
    const res = await api.putInterests(
      req('PUT', '/api/app/interests', {
        body: { interests: '  Омск\u0007​,\r\n\n\n\nэкономика  ' },
      }),
    );
    expect(interestsResponseSchema.parse(await res.json())).toEqual({
      interests: 'Омск,\n\nэкономика',
      maxLength: 500,
    });
    expect(store.users.get(1)?.interests).toBe('Омск,\n\nэкономика');
    const got = await (await api.getInterests(req('GET', '/api/app/interests'))).json();
    expect(got).toEqual({ interests: 'Омск,\n\nэкономика', maxLength: 500 });
  });

  it('stores empty interests as null', async () => {
    const { api, store } = setup();
    await api.putInterests(req('PUT', '/api/app/interests', { body: { interests: ' \n ' } }));
    expect(store.users.get(1)?.interests).toBeNull();
  });

  it('accepts exactly 500 chars and rejects 501', async () => {
    const { api } = setup();
    const ok = await api.putInterests(
      req('PUT', '/api/app/interests', { body: { interests: 'a'.repeat(500) } }),
    );
    expect(ok.status).toBe(200);
    const long = await api.putInterests(
      req('PUT', '/api/app/interests', { body: { interests: 'a'.repeat(501) } }),
    );
    expect(long.status).toBe(422);
    expect(await errorOf(long)).toBe('too_long');
  });

  it('cleanInterests keeps single newlines', () => {
    expect(cleanInterests('a\nb')).toBe('a\nb');
    expect(cleanInterests('\t')).toBeNull();
  });
});

describe('issues', () => {
  const withChannels = async () => {
    const ctx = setup();
    await ctx.api.me(req('GET', '/api/app/me'));
    ctx.store.channels.set(1, [channel('econnews')]);
    return ctx;
  };

  it('starts a build, schedules it once and reports the quota', async () => {
    const { api, store, tasks, lines } = await withChannels();
    const res = await api.buildIssue(req('POST', '/api/app/issues'));
    expect(res.status).toBe(202);
    const body = buildResponseSchema.parse(await res.json());
    expect(body.issue).toMatchObject({ status: 'pending', progress: { step: 'collecting' } });
    expect(body.quota).toEqual({ limit: 3, used: 1, remaining: 2 });
    expect(tasks).toHaveLength(1);
    expect(store.claims[0]).toMatchObject({
      userId: 1,
      perUserLimit: 3,
      globalLimit: 30,
      since: new Date('2026-11-14T21:00:00Z'),
      staleBefore: new Date(now.getTime() - 330_000),
    });
    // The scheduled run never rejects: failures are logged as metadata.
    await expect(tasks[0]?.()).resolves.toBeUndefined();
    expect(lines.some((line) => line.includes(`build ${body.issue.id}: failed`))).toBe(true);
  });

  it('answers 409 busy with the in-flight issue id', async () => {
    const { api, store, tasks } = await withChannels();
    const building = store.add(1, { status: 'collecting' });
    const res = await api.buildIssue(req('POST', '/api/app/issues'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'busy', issueId: building.id });
    expect(tasks).toHaveLength(0);
  });

  it('answers 429 limit after 3 counted builds; free failures do not count', async () => {
    const { api, store } = await withChannels();
    store.add(1, { status: 'failed', error: 'no_posts: none' });
    store.add(1, { status: 'failed', error: 'collect_failed: x' });
    store.add(1, { status: 'ready', number: 1 });
    store.add(1, { status: 'failed', error: 'digest_failed: x' });
    const third = await api.buildIssue(req('POST', '/api/app/issues'));
    expect(third.status).toBe(202);
    store.issues.at(-1)!.status = 'ready';
    const res = await api.buildIssue(req('POST', '/api/app/issues'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'limit',
      quota: { limit: 3, used: 3, remaining: 0 },
    });
  });

  it('answers 429 limit_global, the owner included', async () => {
    const ctx = setup({ env: { MAX_BUILDS_PER_DAY_GLOBAL: 1 } });
    const owner = `tma ${initData({ id: OWNER })}`;
    await ctx.api.me(req('GET', '/', { auth: owner }));
    ctx.store.channels.set(1, [channel('econnews')]);
    ctx.store.add(99, { status: 'ready', number: 1 });
    const res = await ctx.api.buildIssue(req('POST', '/api/app/issues', { auth: owner }));
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('limit_global');
  });

  it('answers 422 no_channels without inserting', async () => {
    const { api, store, tasks } = setup();
    const res = await api.buildIssue(req('POST', '/api/app/issues'));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe('no_channels');
    expect(store.issues).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  it('exempts only the prod-signed owner from the per-user limit', async () => {
    const { api, store } = setup();
    for (const token of [PROD, DEV]) {
      const auth = `tma ${initData({ id: OWNER, token })}`;
      await api.me(req('GET', '/', { auth }));
      store.channels.set(1, [channel('econnews')]);
      await api.buildIssue(req('POST', '/api/app/issues', { auth }));
      store.issues.at(-1)!.status = 'ready';
    }
    expect(store.claims.map((claim) => claim.perUserLimit)).toEqual([null, 3]);
  });

  it('answers 500 before any claim when the LLM env is invalid', async () => {
    const ctx = setup({
      pipeline: () => {
        throw new EnvError('Invalid environment variables:\n  - GOOGLE_GENERATIVE_AI_API_KEY: x');
      },
    });
    await ctx.api.me(req('GET', '/api/app/me'));
    ctx.store.channels.set(1, [channel('econnews')]);
    const res = await ctx.api.buildIssue(req('POST', '/api/app/issues'));
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('misconfigured');
    expect(ctx.store.claims).toHaveLength(0);
  });

  it('returns only the user own issue; a non-uuid never reaches the store', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    const foreign = store.add(7, { status: 'ready', number: 1 });
    const mine = store.add(1, { status: 'failed', error: 'no_news: x' });

    const other = await api.getIssue(req('GET', '/'), foreign.id);
    expect(other.status).toBe(404);
    const calls = store.getIssueCalls;
    const bad = await api.getIssue(req('GET', '/'), "1' or 1=1");
    expect(bad.status).toBe(404);
    expect(store.getIssueCalls).toBe(calls);

    const own = issueResponseSchema.parse(
      await (await api.getIssue(req('GET', '/'), mine.id)).json(),
    );
    expect(own.issue).toMatchObject({ status: 'failed', error: 'no_news', number: null });
  });

  it('does not register a reader who opens a shared issue', async () => {
    const { api, store } = setup();
    const shared = store.add(7, { status: 'ready', number: 1 });
    const res = await api.getIssue(req('GET', '/'), shared.id);
    expect(res.status).toBe(404);
    expect(store.users.size).toBe(0);
  });

  it('pages the archive newest first', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    for (const number of [1, 2, 3]) store.add(1, { status: 'ready', number });
    store.add(1, { status: 'failed', error: 'no_news: x' });
    const first = issuesResponseSchema.parse(
      await (await api.listIssues(req('GET', '/api/app/issues?limit=2'))).json(),
    );
    expect(first.issues.map((issue) => issue.number)).toEqual([3, 2]);
    expect(first.nextBefore).toBe(2);
    expect(first.issues[0]?.dateline).toBe('15 ноября 2026');
    const second = issuesResponseSchema.parse(
      await (await api.listIssues(req('GET', '/api/app/issues?limit=2&before=2'))).json(),
    );
    expect(second.issues.map((issue) => issue.number)).toEqual([1]);
    expect(second.nextBefore).toBeNull();
    const bad = await api.listIssues(req('GET', '/api/app/issues?limit=500'));
    expect(bad.status).toBe(400);
  });
});

const content = (headline: string) => ({
  masthead: { dateline: '15 ноября 2026' },
  lead: { headline },
});

describe('delete issue', () => {
  const del = (api: ReturnType<typeof setup>['api'], id: string) =>
    api.deleteIssue(req('DELETE', `/api/app/issues/${id}`), id);

  it('soft-deletes the own ready issue; a repeat call is still 200', async () => {
    const { api, store, lines } = setup();
    await api.me(req('GET', '/api/app/me'));
    const issue = store.add(1, { status: 'ready', number: 1 });

    const first = await del(api, issue.id);
    expect(first.status).toBe(200);
    expect(deleteIssueResponseSchema.parse(await first.json())).toEqual({ ok: true });
    expect(issue.deletedAt).toEqual(now);
    expect((await del(api, issue.id)).status).toBe(200);
    expect(lines).toContain(`[app] issue ${issue.id}: deleted`);
  });

  it('answers 404 for a foreign, failed or malformed id and touches nothing', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    const foreign = store.add(7, { status: 'ready', number: 1 });
    const failed = store.add(1, { status: 'failed', error: 'no_news: x' });

    for (const id of [foreign.id, failed.id, "1' or 1=1", UUID(99)]) {
      const res = await del(api, id);
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('not_found');
    }
    expect(store.issues.every((issue) => issue.deletedAt === null)).toBe(true);
  });

  it('answers 409 busy for an issue still being built', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    const building = store.add(1, { status: 'digesting' });
    const res = await del(api, building.id);
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'busy', issueId: building.id });
    expect(building.deletedAt).toBeNull();
  });

  it('hides the deleted issue from the archive, me.latestIssue and GET', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.add(1, { status: 'ready', number: 1 });
    const second = store.add(1, { status: 'ready', number: 2 });
    await del(api, second.id);

    const me = meResponseSchema.parse(await (await api.me(req('GET', '/api/app/me'))).json());
    expect(me.latestIssue?.number).toBe(1);
    const list = issuesResponseSchema.parse(
      await (await api.listIssues(req('GET', '/api/app/issues'))).json(),
    );
    expect(list.issues.map((issue) => issue.number)).toEqual([1]);
    expect((await api.getIssue(req('GET', '/'), second.id)).status).toBe(404);
  });

  it('does not refund the daily quota', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    const issue = store.add(1, { status: 'ready', number: 1 });
    const before = meResponseSchema.parse(await (await api.me(req('GET', '/api/app/me'))).json());
    await del(api, issue.id);
    const after = meResponseSchema.parse(await (await api.me(req('GET', '/api/app/me'))).json());
    expect(before.quota?.used).toBe(1);
    expect(after.quota).toEqual(before.quota);
  });
});

describe('share issue', () => {
  const share = (api: ReturnType<typeof setup>['api'], id: string, auth?: string) =>
    api.shareIssue(
      req('POST', `/api/app/issues/${id}/share`, auth === undefined ? {} : { auth }),
      id,
    );

  it('prepares the card through the prod bot with the issue headline', async () => {
    const ctx = setup();
    await ctx.api.me(req('GET', '/api/app/me'));
    const issue = ctx.store.add(1, { number: 4, contentJson: content('Омск строит мост') });
    const res = await share(ctx.api, issue.id);
    expect(res.status).toBe(200);
    expect(shareIssueResponseSchema.parse(await res.json())).toEqual({
      preparedMessageId: 'prepared-1',
    });
    expect(ctx.share).toHaveBeenCalledWith({
      bot: 'prod',
      telegramUserId: 42,
      issueId: issue.id,
      number: 4,
      headline: 'Омск строит мост',
    } satisfies ShareRequest);
  });

  it('uses the dev bot for dev-signed initData', async () => {
    const ctx = setup();
    const auth = `tma ${initData({ token: DEV })}`;
    await ctx.api.me(req('GET', '/api/app/me', { auth }));
    const issue = ctx.store.add(1, { number: 1 });
    expect((await share(ctx.api, issue.id, auth)).status).toBe(200);
    expect(ctx.share.mock.calls[0]?.[0]).toMatchObject({ bot: 'dev', headline: null });
  });

  it('never prepares a card for a foreign, deleted or unfinished issue', async () => {
    const ctx = setup();
    await ctx.api.me(req('GET', '/api/app/me'));
    const ids = [
      ctx.store.add(7, { number: 1 }).id,
      ctx.store.add(1, { number: 2, deletedAt: now }).id,
      ctx.store.add(1, { status: 'composing' }).id,
      'not-a-uuid',
    ];
    for (const id of ids) {
      const res = await share(ctx.api, id);
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('not_found');
    }
    expect(ctx.share).not.toHaveBeenCalled();
  });

  it('answers 500 on a Bot API failure without logging the token', async () => {
    const ctx = setup({
      share: async () => {
        throw new Error(`request to https://api.telegram.org/bot${PROD}/x failed`);
      },
    });
    await ctx.api.me(req('GET', '/api/app/me'));
    const issue = ctx.store.add(1, { number: 1 });
    const res = await share(ctx.api, issue.id);
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('internal');
    expect(ctx.lines.join('\n')).not.toContain(PROD);
    expect(ctx.lines.join('\n')).not.toContain('prod-token');
  });
});

describe('pdf link', () => {
  it('returns the signed link for the own ready issue', async () => {
    const ctx = setup();
    await ctx.api.me(req('GET', '/api/app/me'));
    const issue = ctx.store.add(1, { number: 3 });
    const res = await ctx.api.pdfLink(req('POST', '/'), issue.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = pdfLinkResponseSchema.parse(await res.json());
    expect(body.fileName).toBe('Podpiska-3.pdf');
    expect(ctx.pdfLink).toHaveBeenCalledWith({ issueId: issue.id, number: 3 });
  });

  it('answers 404 for a foreign or deleted issue', async () => {
    const ctx = setup();
    await ctx.api.me(req('GET', '/api/app/me'));
    for (const issue of [ctx.store.add(7, { number: 1 }), ctx.store.add(1, { deletedAt: now })]) {
      expect((await ctx.api.pdfLink(req('POST', '/'), issue.id)).status).toBe(404);
    }
    expect(ctx.pdfLink).not.toHaveBeenCalled();
  });

  it('answers 500 misconfigured when the PDF env is invalid', async () => {
    const ctx = setup();
    ctx.pdfLink.mockImplementation(() => {
      throw new EnvError('Invalid environment variables:\n  - APP_URL: is required');
    });
    await ctx.api.me(req('GET', '/api/app/me'));
    const issue = ctx.store.add(1, { number: 1 });
    const res = await ctx.api.pdfLink(req('POST', '/'), issue.id);
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('misconfigured');
  });
});

describe('schedule', () => {
  const HOUR = 3_600_000;
  const meOf = async (api: ReturnType<typeof setup>['api'], path = '/api/app/me', auth?: string) =>
    meResponseSchema.parse(
      await (await api.me(req('GET', path, auth === undefined ? {} : { auth }))).json(),
    );
  const put = (api: ReturnType<typeof setup>['api'], body: unknown, auth?: string) =>
    api.putSchedule(
      req('PUT', '/api/app/schedule', { body, ...(auth === undefined ? {} : { auth }) }),
    );

  it('sets can_notify only for prod-signed initData that allows writing', async () => {
    const cases: [string, boolean][] = [
      [`tma ${initData({ id: 1 })}`, true],
      [`tma ${initData({ id: 2, write: false })}`, false],
      [`tma ${initData({ id: 3, token: DEV })}`, false],
    ];
    const { api, store } = setup();
    for (const [auth, expected] of cases) {
      const body = await meOf(api, '/api/app/me', auth);
      expect(body.schedule.canNotify).toBe(expected);
    }
    expect([...store.users.values()].map((u) => u.schedule.canNotifyAt !== null)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('stores a valid ?tz and silently ignores an invalid one', async () => {
    const { api, store } = setup();
    expect((await meOf(api, '/api/app/me?tz=Asia%2FKolkata')).schedule.timeZone).toBe(
      'Asia/Kolkata',
    );
    expect(store.users.get(1)?.schedule.timeZone).toBe('Asia/Kolkata');
    const res = await api.me(req('GET', '/api/app/me?tz=Mars%2FOlympus'));
    expect(res.status).toBe(200);
    expect(store.users.get(1)?.schedule.timeZone).toBe('Asia/Kolkata');
    await api.me(req('GET', `/api/app/me?tz=${'x'.repeat(100)}`));
    expect(store.users.get(1)?.schedule.timeZone).toBe('Asia/Kolkata');
  });

  it('me arms the schedule only after a ready issue (no backfill needed)', async () => {
    const { api, store } = setup();
    const first = await meOf(api);
    expect(first.schedule).toMatchObject({ active: false, nextIssueAt: null });

    // 10:00 MSK on the 15th; daily at 08:00 MSK → the 16th 05:00Z.
    store.add(1, { status: 'ready', number: 1, periodEnd: new Date('2026-11-15T07:00:00Z') });
    const armed = await meOf(api);
    expect(armed.schedule).toMatchObject({
      active: true,
      nextIssueAt: '2026-11-16T05:00:00.000Z',
    });
  });

  it('does not arm without permission to notify', async () => {
    const { api, store } = setup();
    const auth = `tma ${initData({ write: false })}`;
    await meOf(api, '/api/app/me', auth);
    store.add(1, { status: 'ready', number: 1 });
    const body = await meOf(api, '/api/app/me', auth);
    expect(body.schedule).toMatchObject({ active: false, canNotify: false, nextIssueAt: null });
  });

  it('validates PUT and answers the view', async () => {
    const { api, schedules } = setup();
    await api.me(req('GET', '/api/app/me'));
    for (const body of [
      { enabled: true, everyDays: 2, hour: 8 },
      { enabled: true, everyDays: 1, hour: 24 },
      { enabled: true, everyDays: 1, hour: -1 },
      { enabled: true, everyDays: 1, hour: 8.5 },
      { enabled: 'yes', everyDays: 1, hour: 8 },
      { enabled: true, everyDays: 1, hour: 8, timeZone: 'Mars/Olympus' },
      { enabled: true, everyDays: 1, hour: 8, timeZone: 'x'.repeat(65) },
    ]) {
      const res = await put(api, body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('bad_request');
    }
    expect(schedules.updates).toHaveLength(0);

    const res = await put(api, {
      enabled: true,
      everyDays: 7,
      hour: 21,
      timeZone: 'Europe/Berlin',
    });
    expect(res.status).toBe(200);
    const { schedule } = scheduleResponseSchema.parse(await res.json());
    expect(schedule).toEqual({
      enabled: true,
      everyDays: 7,
      hour: 21,
      timeZone: 'Europe/Berlin',
      nextIssueAt: null,
      paused: false,
      active: false,
      canNotify: true,
    });
    const got = scheduleResponseSchema.parse(
      await (await api.getSchedule(req('GET', '/api/app/schedule'))).json(),
    );
    expect(got.schedule).toEqual(schedule);
  });

  it('enable clears a pause and re-arms from the last issue; disable disarms', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.add(1, { status: 'ready', number: 1, periodEnd: new Date('2026-11-15T07:00:00Z') });
    const user = store.users.get(1)!;
    user.schedule.pausedAt = new Date('2026-11-14T00:00:00Z');

    const off = scheduleResponseSchema.parse(
      await (await put(api, { enabled: false, everyDays: 1, hour: 8 })).json(),
    );
    expect(off.schedule).toMatchObject({ enabled: false, active: false, nextIssueAt: null });
    expect(user.schedule.pausedAt).not.toBeNull();

    const on = scheduleResponseSchema.parse(
      await (await put(api, { enabled: true, everyDays: 3, hour: 9 })).json(),
    );
    // Base date 15th (MSK) + 3 days at 09:00 MSK.
    expect(on.schedule).toMatchObject({
      enabled: true,
      paused: false,
      active: true,
      nextIssueAt: '2026-11-18T06:00:00.000Z',
    });
    expect(user.schedule.pausedAt).toBeNull();
    expect(user.schedule.nextIssueAt?.toISOString()).toBe('2026-11-18T06:00:00.000Z');
  });

  it('counts a write-access grant only from the prod bot', async () => {
    const devAuth = `tma ${initData({ write: false, token: DEV })}`;
    const prodAuth = `tma ${initData({ write: false })}`;
    const body = { enabled: true, everyDays: 1, hour: 8, writeAccessGranted: true };

    const dev = setup();
    await dev.api.me(req('GET', '/', { auth: devAuth }));
    const viaDev = scheduleResponseSchema.parse(await (await put(dev.api, body, devAuth)).json());
    expect(viaDev.schedule.canNotify).toBe(false);

    const prod = setup();
    await prod.api.me(req('GET', '/', { auth: prodAuth }));
    prod.store.add(1, { status: 'ready', number: 1 });
    const viaProd = scheduleResponseSchema.parse(
      await (await put(prod.api, body, prodAuth)).json(),
    );
    expect(viaProd.schedule).toMatchObject({ canNotify: true, active: true });
    expect(prod.schedules.updates.at(-1)?.[1].canNotifyAt).toEqual(now);
  });

  it('a manual build uses the manual trigger and the schedule window', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    store.channels.set(1, [channel('econnews')]);
    store.users.get(1)!.schedule.everyDays = 7;
    await api.buildIssue(req('POST', '/api/app/issues'));
    expect(store.claims[0]?.trigger).toBe('manual');
    expect(store.claims[0]?.period.start).toEqual(new Date(now.getTime() - 7 * 24 * HOUR));

    store.issues.at(-1)!.status = 'failed';
    store.users.get(1)!.schedule.enabled = false;
    await api.buildIssue(req('POST', '/api/app/issues'));
    expect(store.claims[1]?.period.start).toEqual(new Date(now.getTime() - 24 * HOUR));
  });

  it('scheduled builds do not use up the manual quota', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    for (let i = 0; i < 3; i += 1) store.add(1, { status: 'ready', trigger: 'scheduled' });
    expect((await meOf(api)).quota).toEqual({ limit: 3, used: 0, remaining: 3 });
  });

  it('arms the schedule only after the build is ready', async () => {
    const { digests, issues } = seedStores();
    const pipelineDeps: PipelineDeps = {
      issues,
      digests,
      collect: async (names) =>
        names.map((username) => ({ username, ok: true, collected: 1, inserted: 0 })),
      llm: {
        fast: mockStage('fast', () => JSON.stringify({ items: [] })).stage,
        smart: mockStage('smart', () => JSON.stringify(validDraft())).stage,
      },
      now: () => now,
    };
    const ok = setup({ pipeline: () => pipelineDeps });
    await ok.api.me(req('GET', '/api/app/me'));
    ok.store.channels.set(1, [channel('econnews')]);
    const started = buildResponseSchema.parse(
      await (await ok.api.buildIssue(req('POST', '/api/app/issues'))).json(),
    );
    const id = started.issue.id;
    const row = ok.store.issues.find((i) => i.id === id)!;
    issues.issues.set(id, {
      id,
      userId: 1,
      status: 'pending',
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: now,
      number: null,
      error: null,
      content: null,
      history: ['pending'],
    });
    // The app store mirrors the pipeline: the row is ready by the time the schedule is armed.
    row.status = 'ready';
    row.number = 1;
    expect(ok.store.users.get(1)!.schedule.nextIssueAt).toBeNull();
    await ok.tasks[0]?.();
    expect(issues.issues.get(id)?.status).toBe('ready');
    expect(ok.store.users.get(1)!.schedule.nextIssueAt?.toISOString()).toBe(
      '2026-11-16T05:00:00.000Z',
    );

    // A failed build never arms, even with an older ready issue around.
    const failed = setup();
    await failed.api.me(req('GET', '/api/app/me'));
    failed.store.channels.set(1, [channel('econnews')]);
    await failed.api.buildIssue(req('POST', '/api/app/issues'));
    failed.store.add(1, { status: 'ready', number: 1 });
    await failed.tasks[0]?.();
    expect(failed.store.users.get(1)!.schedule.nextIssueAt).toBeNull();
  });

  it('marks opened only the own ready issue', async () => {
    const { api, store } = setup();
    await api.me(req('GET', '/api/app/me'));
    const ready = store.add(1, { status: 'ready', number: 1, trigger: 'scheduled' });
    const building = store.add(1, { status: 'digesting' });
    const foreign = store.add(7, { status: 'ready', number: 1 });
    await api.getIssue(req('GET', '/'), building.id);
    await api.getIssue(req('GET', '/'), foreign.id);
    expect(store.opened).toEqual([]);
    await api.getIssue(req('GET', '/'), ready.id);
    expect(store.opened).toEqual([ready.id]);
    expect(ready.openedAt).toEqual(now);
  });
});
