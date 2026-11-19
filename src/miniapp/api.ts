import { z } from 'zod';

import {
  AddChannelError,
  LookupLimitError,
  type AddChannelFailure,
  type AddChannelResult,
  type BulkLinkResult,
  type ResolveChannelsResult,
  type ResolveOptions,
} from '@/channels';
import { avatarPath } from '@/channels/avatar';
import { InvalidChannelError, normalizeChannel } from '@/collector';
import { EnvError, type MiniAppEnv } from '@/lib/env';
import { formatDateline, mskDay } from '@/pipeline/day';
import { safeMessage } from '@/pipeline/errors';
import { executeIssueRun, newIssueRun, planIssuePeriod, type PipelineDeps } from '@/pipeline/run';
import { ensureActive, mayActivate, slotAfterIssue, zoneOf } from '@/schedule/service';
import type { ScheduleStore, ScheduleUser } from '@/schedule/store';
import { isValidTimeZone } from '@/schedule/time';

import { isOwner, parseAuthHeader, verifyInitData, type MiniAppAuth } from './auth';
import type { PdfSendResult } from './pdf-send';
import {
  addChannelRequestSchema,
  BULK_BODY_MAX_BYTES,
  bulkAddRequestSchema,
  resolveChannelsRequestSchema,
  DAILY_BUILDS,
  DAILY_PDF_SENDS,
  INTERESTS_MAX,
  FREQUENCIES,
  issuesQuerySchema,
  putInterestsRequestSchema,
  putScheduleRequestSchema,
  removeChannelRequestSchema,
  type AddChannelResponse,
  type ApiError,
  type BulkAddResponse,
  type BulkStatus,
  type ResolveChannelsResponse,
  type ResolvedChannel,
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
  type Frequency,
  type RemoveChannelResponse,
  type ScheduleResponse,
  type ScheduleView,
  type SendPdfResponse,
  type ShareIssueResponse,
} from './contract';
import {
  errorCode,
  issueState,
  isStale,
  PIPELINE_BUDGET_MS,
  quota,
  quotaDayStart,
  STALE_MS,
} from './status';
import type { AppStore, AppUser, PdfIssueRow, ReadyIssueRow } from './store';

export interface AppApiDeps {
  store: AppStore;
  schedules: Pick<ScheduleStore, 'get' | 'update' | 'setTimezone' | 'activate' | 'recentReady'>;
  /** Throws EnvError when the Mini App env is invalid (→ 500 misconfigured). */
  env: () => MiniAppEnv;
  now: () => Date;
  /** limit null = no channel limit (the owner). */
  addChannel: (userId: number, username: string, limit: number | null) => Promise<AddChannelResult>;
  /** resolveChannels from '@/channels' with the store, an interactive source and a clock bound. */
  resolveChannels: (
    userId: number,
    usernames: readonly string[],
    options: ResolveOptions,
  ) => Promise<ResolveChannelsResult>;
  /** ChannelsStore.linkUserChannels. */
  linkChannels: (
    userId: number,
    usernames: readonly string[],
    limit: number | null,
  ) => Promise<BulkLinkResult[]>;
  /** Pipeline wiring; throws EnvError when the LLM env is invalid (checked before any claim). */
  pipeline: () => PipelineDeps;
  /** Runs work after the response is sent (next/server `after`). */
  schedule: (task: () => Promise<void>) => void;
  /**
   * savePreparedInlineMessage through the bot that signed the initData (its users can only be
   * reached by that bot); returns the prepared message id. Throws on any Bot API failure.
   */
  share: (input: ShareRequest) => Promise<string>;
  /**
   * Sends the issue PDF through the bot that signed the initData: the cached file_id when given,
   * else renders and uploads. cannot_message: the user never started that bot or blocked it.
   * Throws EnvError when the PDF env is invalid.
   */
  sendPdf: (input: SendPdfRequest) => Promise<PdfSendResult>;
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

export interface SendPdfRequest {
  bot: MiniAppAuth['bot'];
  telegramUserId: number;
  issueId: string;
  number: number;
  /** file_id uploaded earlier by this same bot, or null. */
  cachedFileId: string | null;
}

export type Handler = (req: Request) => Promise<Response>;

export interface AppApi {
  me: Handler;
  onboarding: Handler;
  listChannels: Handler;
  addChannel: Handler;
  resolveChannels: Handler;
  bulkAddChannels: Handler;
  removeChannel: Handler;
  getInterests: Handler;
  putInterests: Handler;
  listIssues: Handler;
  buildIssue: Handler;
  getIssue: IdHandler;
  deleteIssue: IdHandler;
  shareIssue: IdHandler;
  sendPdf: IdHandler;
  getSchedule: Handler;
  putSchedule: Handler;
}

export type IdHandler = (req: Request, id: string) => Promise<Response>;

const MAX_BODY_BYTES = 2048;

/** Time budget for t.me fetches of one resolve call; a started fetch may add ~6s more. */
export const RESOLVE_BUDGET_MS = 12_000;

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

/** Reads at most maxBytes, aborting the stream past the cap (Content-Length may be absent). */
async function readCapped(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw fail(413, 'bad_request');
  if (req.body === null) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw fail(413, 'bad_request');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const text = await readCapped(req, options.maxBytes ?? MAX_BODY_BYTES);
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

/** null = no channel limit: the owner (prod-signed initData) is never capped in the Mini App. */
export const channelLimit = (owner: boolean, env: MiniAppEnv): number | null =>
  owner ? null : env.MAX_CHANNELS_PER_USER;

type Normalized = { ok: true; username: string } | { ok: false; reason: 'invalid' | 'private' };

function tryNormalize(input: string): Normalized {
  try {
    return { ok: true, username: normalizeChannel(input) };
  } catch (error) {
    if (!(error instanceof InvalidChannelError)) throw error;
    return { ok: false, reason: error.reason === 'invalid' ? 'invalid' : 'private' };
  }
}

const countBy = <T extends string>(values: readonly T[]): string =>
  Object.entries(
    values.reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');

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

  /**
   * `refresh` (me, onboarding) writes the profile from initData; other routes only read the user
   * and create it if missing. Only `me` stamps can_notify_at: a replayed initData (valid for 24h)
   * on every route would otherwise undo a later "bot cannot reach the user" mark.
   */
  const authenticate = async (
    req: Request,
    mode: 'read' | 'refresh' | 'me' = 'read',
  ): Promise<Session> => {
    const { auth, env } = verify(req);
    const found = mode === 'read' ? await deps.store.findUser(auth.user.id) : undefined;
    // The dev bot's write permission says nothing about the prod bot that sends notices.
    const stamp = mode === 'me' && auth.bot === 'prod' && auth.allowsWriteToPm;
    const user =
      found ?? (await deps.store.upsertUser(auth.user, stamp ? { canNotifyAt: deps.now() } : {}));
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
    const { user, env, owner } = await authenticate(req, 'me');
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
      channels: { count: channelCount, limit: channelLimit(owner, env) },
      hasInterests: user.interests !== null && user.interests.trim() !== '',
      latestIssue: latest === undefined ? null : issueSummary(latest),
      inFlight: inFlight === undefined || isStale(inFlight, now) ? null : issueState(inFlight, now),
      quota: quota(used, owner),
      schedule: scheduleView(schedule),
    };
    return json(200, body);
  });

  const onboarding = route('onboarding', async (req) => {
    const { user } = await authenticate(req, 'refresh');
    const at = await deps.store.markOnboarded(user.id, deps.now());
    const body: OnboardingResponse = { onboardedAt: at.toISOString() };
    return json(200, body);
  });

  const listChannels = route('channels.list', async (req) => {
    const { user, env, owner } = await authenticate(req);
    const rows = await deps.store.listChannels(user.id);
    const body: ChannelsResponse = {
      channels: rows.map((row) => ({
        username: row.username,
        title: row.title,
        avatarUrl: avatarPath(row.username, row.avatarUrl),
        available: row.isAvailable,
      })),
      limit: channelLimit(owner, env),
    };
    return json(200, body);
  });

  const addChannel = route('channels.add', async (req) => {
    const { user, env, owner } = await authenticate(req);
    const limit = channelLimit(owner, env);
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
      result = await deps.addChannel(user.id, username, limit);
    } catch (error) {
      if (!(error instanceof AddChannelError)) throw error;
      throw fail(422, addFailureCode[error.reason]);
    }
    if (result.status === 'limit') {
      throw fail(422, 'channel_limit', limit === null ? {} : { limit });
    }
    const { channel } = result;
    const body: AddChannelResponse = {
      status: result.status,
      channel: {
        username: channel.username,
        title: channel.title,
        avatarUrl: avatarPath(channel.username, channel.avatarUrl),
        available: true,
      },
    };
    return json(result.status === 'added' ? 201 : 200, body);
  });

  const resolveChannels = route('channels.resolve', async (req) => {
    const { user, env, owner } = await authenticate(req);
    const { usernames } = await readBody(req, resolveChannelsRequestSchema);
    const inputs = usernames.map(tryNormalize);
    const valid = [...new Set(inputs.flatMap((input) => (input.ok ? [input.username] : [])))];
    const now = deps.now();
    const day = mskDay(now);
    let resolved: ResolveChannelsResult = { results: [], retryAfterMs: null };
    if (valid.length > 0) {
      try {
        resolved = await deps.resolveChannels(user.id, valid, {
          deadline: now.getTime() + RESOLVE_BUDGET_MS,
          claimLookups: (count) =>
            owner
              ? Promise.resolve(count)
              : deps.store.claimChannelLookups(
                  user.id,
                  day,
                  count,
                  env.MAX_CHANNEL_LOOKUPS_PER_DAY,
                ),
          refundLookups: (count) =>
            owner ? Promise.resolve() : deps.store.refundChannelLookups(user.id, day, count),
        });
      } catch (error) {
        if (error instanceof LookupLimitError) throw fail(429, 'lookup_limit');
        throw error;
      }
    }
    const byName = new Map(resolved.results.map((result) => [result.username, result]));
    const results = usernames.map((raw, index): ResolvedChannel => {
      const input = inputs[index];
      if (input === undefined || !input.ok) {
        return { username: raw, status: input?.reason ?? 'invalid' };
      }
      const found = byName.get(input.username);
      if (found === undefined) return { username: input.username, status: 'pending' };
      return {
        username: input.username,
        status: found.status,
        ...(found.channel === undefined
          ? {}
          : {
              title: found.channel.title,
              avatarUrl: avatarPath(found.channel.username, found.channel.avatarUrl),
            }),
      };
    });
    deps.log(`[app] channels.resolve: ${countBy(results.map((result) => result.status))}`);
    const body: ResolveChannelsResponse = { results, retryAfterMs: resolved.retryAfterMs };
    return json(200, body);
  });

  const bulkAddChannels = route('channels.bulk', async (req) => {
    const { user, env, owner } = await authenticate(req);
    const { usernames } = await readBody(req, bulkAddRequestSchema, {
      maxBytes: BULK_BODY_MAX_BYTES,
    });
    const limit = channelLimit(owner, env);
    const keys = new Set<string>();
    const valid: string[] = [];
    for (const raw of usernames) {
      const input = tryNormalize(raw);
      const key = input.ok ? input.username : raw;
      if (keys.has(key)) continue;
      keys.add(key);
      if (input.ok) valid.push(input.username);
    }
    const linked = valid.length === 0 ? [] : await deps.linkChannels(user.id, valid, limit);
    const statusOf = new Map<string, BulkStatus>(linked.map((r) => [r.username, r.status]));
    const results = [...keys].map((username) => ({
      username,
      status: statusOf.get(username) ?? 'not_found',
    }));
    const added = results.filter((result) => result.status === 'added').length;
    deps.log(`[app] channels.bulk: ${countBy(results.map((result) => result.status))}`);
    if (added === 0 && results.some((result) => result.status === 'limit')) {
      throw fail(422, 'channel_limit', limit === null ? {} : { limit });
    }
    const body: BulkAddResponse = {
      results,
      added,
      count: await deps.store.countChannels(user.id),
      limit,
    };
    return json(200, body);
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
  const readyIssue = async (userId: number, id: string): Promise<PdfIssueRow> => {
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

  const sendPdf = route('issues.pdf', async (req, id: string) => {
    const { auth, user, owner } = await authenticate(req);
    const row = await readyIssue(user.id, id);
    const cachedFileId = row.pdfFile?.bot === auth.bot ? row.pdfFile.fileId : null;

    // Taken before sending (atomic), given back on any failure: only successful sends count.
    const day = mskDay(deps.now());
    const limited = !owner;
    if (limited && !(await deps.store.claimPdfSend(user.id, day, DAILY_PDF_SENDS))) {
      throw fail(429, 'limit');
    }
    let result: PdfSendResult;
    try {
      result = await deps.sendPdf({
        bot: auth.bot,
        telegramUserId: auth.user.id,
        issueId: row.id,
        number: row.number,
        cachedFileId,
      });
    } catch (error) {
      if (limited) await deps.store.refundPdfSend(user.id, day);
      throw error;
    }
    if (result.kind === 'cannot_message') {
      if (limited) await deps.store.refundPdfSend(user.id, day);
      throw fail(409, 'cannot_message');
    }
    if (result.fileId !== null && result.fileId !== cachedFileId) {
      try {
        await deps.store.savePdfFile(row.id, { fileId: result.fileId, bot: auth.bot });
      } catch (error) {
        // The user already has the PDF; a lost cache entry only costs the next render.
        deps.log(`[app] issue ${row.id}: pdf not cached: ${safeMessage(error)}`);
      }
    }
    deps.log(`[app] issue ${row.id}: pdf sent`);
    const body: SendPdfResponse = { ok: true };
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
    // Trust-on-client: a forged flag only arms notices the bot sends to this same user, and the
    // first unreachable send clears can_notify_at again.
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
    resolveChannels,
    bulkAddChannels,
    removeChannel,
    getInterests,
    putInterests,
    listIssues,
    buildIssue,
    getIssue,
    deleteIssue,
    shareIssue,
    sendPdf,
  };
}
