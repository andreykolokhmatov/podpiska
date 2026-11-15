import { z } from 'zod';

import { AddChannelError, type AddChannelFailure, type AddChannelResult } from '@/channels';
import { InvalidChannelError, normalizeChannel } from '@/collector';
import { EnvError, type MiniAppEnv } from '@/lib/env';
import { formatDateline, mskDay } from '@/pipeline/day';
import { safeMessage } from '@/pipeline/errors';
import { executeIssueRun, newIssueRun, planIssuePeriod, type PipelineDeps } from '@/pipeline/run';
import { ensureActive, mayActivate, slotAfterIssue, zoneOf } from '@/schedule/service';
import type { ScheduleStore, ScheduleUser } from '@/schedule/store';
import { isValidTimeZone } from '@/schedule/time';

import { isOwner, parseAuthHeader, verifyInitData, type MiniAppAuth } from './auth';
import {
  addChannelRequestSchema,
  DAILY_BUILDS,
  INTERESTS_MAX,
  FREQUENCIES,
  issuesQuerySchema,
  putInterestsRequestSchema,
  putScheduleRequestSchema,
  removeChannelRequestSchema,
  type AddChannelResponse,
  type ApiError,
  type ApiErrorCode,
  type BuildResponse,
  type ChannelsResponse,
  type DeleteIssueResponse,
  type InterestsResponse,
  type IssueResponse,
  type IssueSummary,
  type IssuesResponse,
  type MeResponse,
  type OnboardingResponse,
  type PdfLinkResponse,
  type Frequency,
  type RemoveChannelResponse,
  type ScheduleResponse,
  type ScheduleView,
  type ShareIssueResponse,
} from './contract';
import type { PdfLink } from './pdf-link';
import {
  errorCode,
  issueState,
  isStale,
  PIPELINE_BUDGET_MS,
  quota,
  quotaDayStart,
  STALE_MS,
} from './status';
import type { AppStore, AppUser, ReadyIssueRow } from './store';

export interface AppApiDeps {
  store: AppStore;
  schedules: Pick<ScheduleStore, 'get' | 'update' | 'setTimezone' | 'activate' | 'recentReady'>;
  /** Throws EnvError when the Mini App env is invalid (→ 500 misconfigured). */
  env: () => MiniAppEnv;
  now: () => Date;
  addChannel: (userId: number, username: string, limit: number) => Promise<AddChannelResult>;
  /** Pipeline wiring; throws EnvError when the LLM env is invalid (checked before any claim). */
  pipeline: () => PipelineDeps;
  /** Runs work after the response is sent (next/server `after`). */
  schedule: (task: () => Promise<void>) => void;
  /**
   * savePreparedInlineMessage through the bot that signed the initData (its users can only be
   * reached by that bot); returns the prepared message id. Throws on any Bot API failure.
   */
  share: (input: ShareRequest) => Promise<string>;
  /** Signed public PDF URL; throws EnvError when the PDF env is invalid. */
  pdfLink: (input: { issueId: string; number: number }) => PdfLink;
  /** Metadata only: never initData, interests or tokens. */
  log: (line: string) => void;
}

export interface ShareRequest {
  bot: MiniAppAuth['bot'];
  telegramUserId: number;
  issueId: string;
  number: number;
  headline: string | null;
}

export type Handler = (req: Request) => Promise<Response>;

export interface AppApi {
  me: Handler;
  onboarding: Handler;
  listChannels: Handler;
  addChannel: Handler;
  removeChannel: Handler;
  getInterests: Handler;
  putInterests: Handler;
  listIssues: Handler;
  buildIssue: Handler;
  getIssue: IdHandler;
  deleteIssue: IdHandler;
  shareIssue: IdHandler;
  pdfLink: IdHandler;
  getSchedule: Handler;
  putSchedule: Handler;
}

export type IdHandler = (req: Request, id: string) => Promise<Response>;

const MAX_BODY_BYTES = 2048;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: NO_STORE });

class ApiFailure extends Error {
  override readonly name = 'ApiFailure';
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

const fail = (status: number, error: ApiErrorCode, extra: Omit<ApiError, 'error'> = {}) =>
  new ApiFailure(status, { error, ...extra });

async function readBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw fail(413, 'bad_request');
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw fail(413, 'bad_request');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail(400, 'bad_request');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw fail(400, 'bad_request');
  return parsed.data;
}

// C0/C1 controls except \n, zero-width and bidi characters.
const UNSAFE_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

/** Trimmed, controls stripped, at most 2 consecutive newlines; empty → null. */
export function cleanInterests(raw: string): string | null {
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned === '' ? null : cleaned;
}

const summarySchema = z.object({
  masthead: z.object({ dateline: z.string() }),
  lead: z.object({ headline: z.string() }).optional(),
});

function issueSummary(row: ReadyIssueRow): IssueSummary {
  const parsed = summarySchema.safeParse(row.contentJson);
  return {
    id: row.id,
    number: row.number,
    dateline: parsed.success
      ? parsed.data.masthead.dateline
      : formatDateline([mskDay(row.createdAt)]),
    headline: parsed.success ? (parsed.data.lead?.headline ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const addFailureCode: Record<AddChannelFailure, ApiErrorCode> = {
  private: 'private',
  not_found: 'channel_not_found',
  invalid: 'invalid',
  retry_later: 'retry_later',
};

const uuidSchema = z.uuid();

const asFrequency = (value: number): Frequency =>
  (FREQUENCIES as readonly number[]).includes(value) ? (value as Frequency) : 1;

export function scheduleView(user: ScheduleUser): ScheduleView {
  const paused = user.pausedAt !== null;
  const canNotify = user.canNotifyAt !== null;
  return {
    enabled: user.enabled,
    everyDays: asFrequency(user.everyDays),
    hour: user.hour,
    timeZone: zoneOf(user),
    nextIssueAt: user.nextIssueAt?.toISOString() ?? null,
    paused,
    active: user.nextIssueAt !== null && mayActivate(user),
    canNotify,
  };
}

export function createAppApi(deps: AppApiDeps): AppApi {
  interface Session {
    auth: MiniAppAuth;
    user: AppUser;
    env: MiniAppEnv;
    owner: boolean;
  }

  const verify = (req: Request) => {
    const env = deps.env();
    const raw = parseAuthHeader(req.headers.get('authorization'));
    if (raw === undefined) throw fail(401, 'unauthorized');
    const result = verifyInitData(raw, {
      prodToken: env.TELEGRAM_BOT_TOKEN,
      devToken: env.TELEGRAM_DEV_BOT_TOKEN,
      now: deps.now(),
    });
    if (!result.ok) throw fail(401, result.error);
    return { auth: result.auth, env };
  };

  const authenticate = async (req: Request): Promise<Session> => {
    const { auth, env } = verify(req);
    // The dev bot's write permission says nothing about the prod bot that sends notices.
    const user = await deps.store.upsertUser(
      auth.user,
      auth.bot === 'prod' && auth.allowsWriteToPm ? { canNotifyAt: deps.now() } : {},
    );
    return { auth, user, env, owner: isOwner(auth, env.OWNER_TELEGRAM_ID) };
  };

  const route =
    <A extends unknown[]>(name: string, fn: (req: Request, ...args: A) => Promise<Response>) =>
    async (req: Request, ...args: A): Promise<Response> => {
      try {
        return await fn(req, ...args);
      } catch (error) {
        if (error instanceof ApiFailure) return json(error.status, error.body);
        if (error instanceof EnvError) {
          // EnvError messages list keys and reasons only, never values.
          deps.log(`[app] ${name}: misconfigured: ${error.message}`);
          return json(500, { error: 'misconfigured' });
        }
        deps.log(`[app] ${name}: ${error instanceof Error ? error.name : 'unknown'} error`);
        return json(500, { error: 'internal' });
      }
    };

  const me = route('me', async (req) => {
    const { user, env, owner } = await authenticate(req);
    const now = deps.now();
    const schedule = { ...user.schedule };
    const tz = new URL(req.url).searchParams.get('tz');
    if (tz !== null && tz !== schedule.timeZone && isValidTimeZone(tz)) {
      await deps.schedules.setTimezone(user.id, tz);
      schedule.timeZone = tz;
    }
    // Also arms the schedule of users who got their first issue before scheduling existed.
    schedule.nextIssueAt = await ensureActive(deps.schedules, schedule, now);
    const [channelCount, [latest], inFlight, used] = await Promise.all([
      deps.store.countChannels(user.id),
      deps.store.listReadyIssues(user.id, { limit: 1 }),
      deps.store.latestInFlight(user.id),
      owner ? Promise.resolve(0) : deps.store.countBuilds(user.id, quotaDayStart(now)),
    ]);
    const body: MeResponse = {
      user: { telegramId: user.telegramId, firstName: user.firstName, username: user.username },
      onboarded: user.onboardedAt !== null,
      owner,
      channels: { count: channelCount, limit: env.MAX_CHANNELS_PER_USER },
      hasInterests: user.interests !== null && user.interests.trim() !== '',
      latestIssue: latest === undefined ? null : issueSummary(latest),
      inFlight: inFlight === undefined || isStale(inFlight, now) ? null : issueState(inFlight, now),
      quota: quota(used, owner),
      schedule: scheduleView(schedule),
    };
    return json(200, body);
  });

  const onboarding = route('onboarding', async (req) => {
    const { user } = await authenticate(req);
    const at = await deps.store.markOnboarded(user.id, deps.now());
    const body: OnboardingResponse = { onboardedAt: at.toISOString() };
    return json(200, body);
  });

  const listChannels = route('channels.list', async (req) => {
    const { user, env } = await authenticate(req);
    const rows = await deps.store.listChannels(user.id);
    const body: ChannelsResponse = {
      channels: rows.map((row) => ({
        username: row.username,
        title: row.title,
        avatarUrl: row.avatarUrl,
        available: row.isAvailable,
      })),
      limit: env.MAX_CHANNELS_PER_USER,
    };
    return json(200, body);
  });

  const addChannel = route('channels.add', async (req) => {
    const { user, env } = await authenticate(req);
    const { input } = await readBody(req, addChannelRequestSchema);
    let username: string;
    try {
      username = normalizeChannel(input);
    } catch (error) {
      if (!(error instanceof InvalidChannelError)) throw error;
      throw fail(422, error.reason === 'invalid' ? 'invalid' : 'private');
    }
    let result: AddChannelResult;
    try {
      result = await deps.addChannel(user.id, username, env.MAX_CHANNELS_PER_USER);
    } catch (error) {
      if (!(error instanceof AddChannelError)) throw error;
      throw fail(422, addFailureCode[error.reason]);
    }
    if (result.status === 'limit') {
      throw fail(422, 'channel_limit', { limit: env.MAX_CHANNELS_PER_USER });
    }
    const { channel } = result;
    const body: AddChannelResponse = {
      status: result.status,
      channel: {
        username: channel.username,
        title: channel.title,
        avatarUrl: channel.avatarUrl,
        available: true,
      },
    };
    return json(result.status === 'added' ? 201 : 200, body);
  });

  const removeChannel = route('channels.remove', async (req) => {
    const { user } = await authenticate(req);
    const { username } = await readBody(req, removeChannelRequestSchema);
    let normalized: string;
    try {
      normalized = normalizeChannel(username);
    } catch (error) {
      if (!(error instanceof InvalidChannelError)) throw error;
      throw fail(404, 'not_found');
    }
    if (!(await deps.store.removeChannel(user.id, normalized))) throw fail(404, 'not_found');
    const body: RemoveChannelResponse = { ok: true };
    return json(200, body);
  });

  const getInterests = route('interests.get', async (req) => {
    const { user } = await authenticate(req);
    const body: InterestsResponse = { interests: user.interests, maxLength: INTERESTS_MAX };
    return json(200, body);
  });

  const putInterests = route('interests.put', async (req) => {
    const { user } = await authenticate(req);
    const { interests: raw } = await readBody(req, putInterestsRequestSchema);
    const interests = cleanInterests(raw);
    if (interests !== null && interests.length > INTERESTS_MAX) throw fail(422, 'too_long');
    await deps.store.setInterests(user.id, interests);
    const body: InterestsResponse = { interests, maxLength: INTERESTS_MAX };
    return json(200, body);
  });

  const listIssues = route('issues.list', async (req) => {
    const { user } = await authenticate(req);
    const params = new URL(req.url).searchParams;
    const query = issuesQuerySchema.safeParse({
      before: params.get('before') ?? undefined,
      limit: params.get('limit') ?? undefined,
    });
    if (!query.success) throw fail(400, 'bad_request');
    const { limit, before } = query.data;
    const rows = await deps.store.listReadyIssues(user.id, {
      limit,
      ...(before === undefined ? {} : { before }),
    });
    const last = rows.at(-1);
    const body: IssuesResponse = {
      issues: rows.map(issueSummary),
      nextBefore: rows.length === limit && last !== undefined ? last.number : null,
    };
    return json(200, body);
  });

  const buildIssue = route('issues.build', async (req) => {
    const { auth, user, env, owner } = await authenticate(req);
    // Fails on a bad LLM env before anything is claimed or inserted.
    const pipeline = deps.pipeline();
    const now = deps.now();
    const maxDays = user.schedule.enabled ? user.schedule.everyDays : 1;
    const period = await planIssuePeriod(pipeline, { userId: user.id, maxDays });
    const claim = await deps.store.claimIssue({
      userId: user.id,
      period,
      trigger: 'manual',
      since: quotaDayStart(now),
      staleBefore: new Date(now.getTime() - STALE_MS),
      perUserLimit: owner ? null : DAILY_BUILDS,
      globalLimit: env.MAX_BUILDS_PER_DAY_GLOBAL,
    });

    switch (claim.kind) {
      case 'busy':
        throw fail(409, 'busy', { issueId: claim.issue.id });
      case 'limit': {
        const today = quota(claim.used, false);
        throw fail(429, 'limit', today === null ? {} : { quota: today });
      }
      case 'limit_global':
        throw fail(429, 'limit_global');
      case 'no_channels':
        throw fail(422, 'no_channels');
      case 'started':
        break;
    }

    const issueId = claim.issue.id;
    const run = newIssueRun(pipeline, {
      issueId,
      userId: user.id,
      period,
      interests: user.interests,
    });
    // The dev bot's write permission says nothing about the prod bot that sends the notice.
    const notifyAllowed = auth.bot === 'prod' && auth.allowsWriteToPm;
    const deadline = new Date(now.getTime() + PIPELINE_BUDGET_MS);
    deps.schedule(async () => {
      try {
        const result = await executeIssueRun(pipeline, run, { deadline, notifyAllowed });
        deps.log(`[app] build ${issueId}: ready №${result.number}`);
      } catch (error) {
        deps.log(`[app] build ${issueId}: failed: ${errorCode(safeMessage(error))}`);
        return;
      }
      try {
        // A manual build never moves an armed schedule; it only arms one that has no slot yet.
        const fresh = await deps.schedules.get(user.id);
        if (fresh !== undefined) await ensureActive(deps.schedules, fresh, deps.now());
      } catch (error) {
        deps.log(`[app] build ${issueId}: schedule not armed: ${safeMessage(error)}`);
      }
    });
    deps.log(`[app] build ${issueId}: started`);

    const body: BuildResponse = {
      issue: issueState(claim.issue, now),
      quota: quota(claim.used, owner),
    };
    return json(202, body);
  });

  // Also the owner check on a shared newspaper: verifies initData without registering the reader.
  const getIssue = route('issues.get', async (req, id: string) => {
    const { auth } = verify(req);
    if (!uuidSchema.safeParse(id).success) throw fail(404, 'not_found');
    const user = await deps.store.findUser(auth.user.id);
    if (user === undefined) throw fail(404, 'not_found');
    const row = await deps.store.getIssue(user.id, id);
    if (row === undefined) throw fail(404, 'not_found');
    // The Mini App asks for its own issue on every open: that is what "read" means for pausing.
    if (row.status === 'ready') await deps.store.markOpened(user.id, row.id);
    const body: IssueResponse = { issue: issueState(row, deps.now()) };
    return json(200, body);
  });

  const deleteIssue = route('issues.delete', async (req, id: string) => {
    const { user } = await authenticate(req);
    if (!uuidSchema.safeParse(id).success) throw fail(404, 'not_found');
    const result = await deps.store.softDeleteIssue(user.id, id);
    if (result === 'not_found') throw fail(404, 'not_found');
    if (result === 'busy') throw fail(409, 'busy', { issueId: id });
    deps.log(`[app] issue ${id}: deleted`);
    const body: DeleteIssueResponse = { ok: true };
    return json(200, body);
  });

  /** The user's own ready, non-deleted issue; anything else is 404 before any side effect. */
  const readyIssue = async (userId: number, id: string): Promise<ReadyIssueRow> => {
    if (!uuidSchema.safeParse(id).success) throw fail(404, 'not_found');
    const row = await deps.store.getReadyIssue(userId, id);
    if (row === undefined) throw fail(404, 'not_found');
    return row;
  };

  const shareIssue = route('issues.share', async (req, id: string) => {
    const { auth, user } = await authenticate(req);
    const row = await readyIssue(user.id, id);
    const preparedMessageId = await deps.share({
      bot: auth.bot,
      telegramUserId: auth.user.id,
      issueId: row.id,
      number: row.number,
      headline: issueSummary(row).headline,
    });
    const body: ShareIssueResponse = { preparedMessageId };
    return json(200, body);
  });

  const pdfLink = route('issues.pdf_link', async (req, id: string) => {
    const { user } = await authenticate(req);
    const row = await readyIssue(user.id, id);
    const body: PdfLinkResponse = deps.pdfLink({ issueId: row.id, number: row.number });
    return json(200, body);
  });

  const getSchedule = route('schedule.get', async (req) => {
    const { user } = await authenticate(req);
    const schedule = { ...user.schedule };
    schedule.nextIssueAt = await ensureActive(deps.schedules, schedule, deps.now());
    const body: ScheduleResponse = { schedule: scheduleView(schedule) };
    return json(200, body);
  });

  const putSchedule = route('schedule.put', async (req) => {
    const { auth, user } = await authenticate(req);
    const input = await readBody(req, putScheduleRequestSchema);
    if (input.timeZone !== undefined && !isValidTimeZone(input.timeZone)) {
      throw fail(400, 'bad_request');
    }
    const now = deps.now();
    const granted = input.writeAccessGranted === true && auth.bot === 'prod';
    const next: ScheduleUser = {
      ...user.schedule,
      enabled: input.enabled,
      everyDays: input.everyDays,
      hour: input.hour,
      timeZone: input.timeZone ?? user.schedule.timeZone,
      pausedAt: input.enabled ? null : user.schedule.pausedAt,
      canNotifyAt: granted ? now : user.schedule.canNotifyAt,
      nextIssueAt: null,
    };
    if (mayActivate(next)) {
      const [last] = await deps.schedules.recentReady(user.id, 1);
      if (last !== undefined) next.nextIssueAt = slotAfterIssue(next, last.periodEnd, now);
    }
    await deps.schedules.update(user.id, {
      enabled: next.enabled,
      everyDays: next.everyDays,
      hour: next.hour,
      timeZone: next.timeZone,
      nextIssueAt: next.nextIssueAt,
      clearPause: input.enabled,
      ...(granted ? { canNotifyAt: now } : {}),
    });
    const body: ScheduleResponse = { schedule: scheduleView(next) };
    return json(200, body);
  });

  return {
    getSchedule,
    putSchedule,
    me,
    onboarding,
    listChannels,
    addChannel,
    removeChannel,
    getInterests,
    putInterests,
    listIssues,
    buildIssue,
    getIssue,
    deleteIssue,
    shareIssue,
    pdfLink,
  };
}
