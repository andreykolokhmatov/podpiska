/**
 * Wire contract of the Mini App API (/api/app/*), shared by the route handlers and the client.
 * Every request carries `Authorization: tma <initDataRaw>`. Every response is JSON with
 * `Cache-Control: no-store`; failures are `{ error: ApiErrorCode, ... }` (see apiErrorSchema).
 */
import { z } from 'zod';

export const AUTH_SCHEME = 'tma';

export const INTERESTS_MAX = 500;
export const CHANNEL_INPUT_MAX = 200;
/** "Build now" presses per Moscow day per user (the owner has none). */
export const DAILY_BUILDS = 3;
/** PDF sends per Moscow day per user (the owner has none). */
export const DAILY_PDF_SENDS = 5;
export const ARCHIVE_PAGE_MAX = 50;
/** Schedule frequencies: every day, every 3 days, every week. */
export const FREQUENCIES = [1, 3, 7] as const;
export type Frequency = (typeof FREQUENCIES)[number];
/** Max length of an IANA time zone name accepted by the API. */
export const TIME_ZONE_MAX = 64;

export const issueStatuses = [
  'pending',
  'collecting',
  'digesting',
  'composing',
  'ready',
  'failed',
] as const;
export type IssueStatus = (typeof issueStatuses)[number];

/**
 * Progress shown on the MainButton:
 * collecting → «Собираем посты…», digesting → «Читаем каналы N/M», composing → «Верстаем номер…».
 */
export const progressSteps = ['collecting', 'digesting', 'composing'] as const;
export type ProgressStep = (typeof progressSteps)[number];

/** Why a build failed (issue.error). */
export const issueErrorCodes = [
  'no_channels',
  'no_posts',
  'collect_failed',
  'digest_failed',
  'no_news',
  'timeout',
  'internal',
] as const;
export type IssueErrorCode = (typeof issueErrorCodes)[number];

/** Failures that spent no LLM money: they count toward no build limit, the global cap included. */
export const FREE_FAILURE_CODES: readonly IssueErrorCode[] = [
  'no_channels',
  'no_posts',
  'collect_failed',
  'no_news',
];

/**
 * Failures that do not use up the user's daily "build now" quota: the free ones, plus timeout,
 * whose retry reuses the digests the failed run already cached. They still count globally.
 */
export const QUOTA_EXEMPT_CODES: readonly IssueErrorCode[] = [...FREE_FAILURE_CODES, 'timeout'];

/** `error` of a non-2xx response. */
export const apiErrorCodes = [
  // 401: missing / bad / unsigned initData; `expired` = auth_date older than 24h (restart the app).
  'unauthorized',
  'expired',
  // 400 malformed body or query; 404 unknown resource (incl. another user's issue).
  'bad_request',
  'not_found',
  // 422 interests longer than INTERESTS_MAX after cleaning.
  'too_long',
  // POST /issues: 409 busy (see issueId), 429 limit (see quota) / limit_global, 422 no_channels.
  // POST /issues/<id>/pdf: 429 limit after DAILY_PDF_SENDS sends today (no quota field).
  'busy',
  'limit',
  'limit_global',
  'no_channels',
  // POST /channels, all 422: over MAX_CHANNELS_PER_USER (see limit), private/invite link,
  // unparsable input, channel missing or web preview closed, t.me not answering.
  'channel_limit',
  'private',
  'invalid',
  'channel_not_found',
  'retry_later',
  // 409: the bot may not write to the user (never started or blocked)
  'cannot_message',
  // 500
  'misconfigured',
  'internal',
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

const isoDate = z.iso.datetime({ offset: true });

export const frequencySchema = z.literal(FREQUENCIES);
export const scheduleHourSchema = z.number().int().min(0).max(23);

export const quotaSchema = z.object({
  limit: z.number().int(),
  used: z.number().int(),
  remaining: z.number().int(),
});
export type Quota = z.infer<typeof quotaSchema>;

export const apiErrorSchema = z.object({
  error: z.enum(apiErrorCodes),
  /** busy: the issue already being built; resume polling it. */
  issueId: z.uuid().optional(),
  /** limit: today's usage. */
  quota: quotaSchema.optional(),
  /** channel_limit: the max channel count. */
  limit: z.number().int().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const issueSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  /** «15 ноября 2026». */
  dateline: z.string(),
  headline: z.string().nullable(),
  createdAt: isoDate,
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;

export const issueStateSchema = z.object({
  id: z.uuid(),
  /** Effective status: an in-flight issue older than the stale limit is reported failed/timeout. */
  status: z.enum(issueStatuses),
  /** Non-null while in flight; done/total only for `digesting`. */
  progress: z
    .object({
      step: z.enum(progressSteps),
      done: z.number().int().nullable(),
      total: z.number().int().nullable(),
    })
    .nullable(),
  /** Non-null only when status is failed. */
  error: z.enum(issueErrorCodes).nullable(),
  /** Non-null only when ready. Open `/issue/<id>?tma=1&theme=<light|dark>`. */
  number: z.number().int().nullable(),
  /** Only for failed/no_news: what the editors read before finding nothing newsworthy. */
  found: z.object({ posts: z.number().int(), channels: z.number().int() }).optional(),
});
export type IssueState = z.infer<typeof issueStateSchema>;

export const channelViewSchema = z.object({
  username: z.string(),
  title: z.string().nullable(),
  /** Expiring t.me CDN URL; render with referrerPolicy=no-referrer and an initials fallback. */
  avatarUrl: z.string().nullable(),
  /** false when the last collect could not read the channel. */
  available: z.boolean(),
});
export type ChannelView = z.infer<typeof channelViewSchema>;

export const scheduleViewSchema = z.object({
  /** The «Собирать автоматически» switch. */
  enabled: z.boolean(),
  everyDays: frequencySchema,
  /** Local hour 0..23 in timeZone; minutes are always :00. */
  hour: scheduleHourSchema,
  /** IANA zone the hour is in (Europe/Moscow until the client reports one). */
  timeZone: z.string(),
  /** Next automatic build; null while not active. Format in timeZone. */
  nextIssueAt: isoDate.nullable(),
  /**
   * Stopped by the server: 3 auto issues in a row unread, or the bot could not reach the user
   * (then canNotify is false too). Saving with enabled=true resumes it.
   */
  paused: z.boolean(),
  /** Armed: enabled, not paused, canNotify and a slot set (needs at least one ready issue). */
  active: z.boolean(),
  /** The prod bot may message the user; false → requestWriteAccess before enabling. */
  canNotify: z.boolean(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

// GET /api/app/me[?tz=<IANA zone>] — upserts the user from initData; everything the hub needs
// in one call. A valid tz (Intl.DateTimeFormat().resolvedOptions().timeZone) is stored; an
// invalid one is ignored.
export const meResponseSchema = z.object({
  user: z.object({
    telegramId: z.number().int(),
    firstName: z.string().nullable(),
    username: z.string().nullable(),
  }),
  onboarded: z.boolean(),
  /** Owner (prod-signed initData only): no daily quota. */
  owner: z.boolean(),
  channels: z.object({ count: z.number().int(), limit: z.number().int() }),
  hasInterests: z.boolean(),
  /** Latest ready issue; null = checklist step 3 not done. */
  latestIssue: issueSummarySchema.nullable(),
  /** An issue being built right now: resume polling it. */
  inFlight: issueStateSchema.nullable(),
  /** null for the owner (hide «Осталось N из 3»). */
  quota: quotaSchema.nullable(),
  schedule: scheduleViewSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// POST /api/app/onboarding — no body; idempotent.
export const onboardingResponseSchema = z.object({ onboardedAt: isoDate });
export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;

// GET /api/app/channels
export const channelsResponseSchema = z.object({
  channels: z.array(channelViewSchema),
  limit: z.number().int(),
});
export type ChannelsResponse = z.infer<typeof channelsResponseSchema>;

// POST /api/app/channels — @username, t.me link or bare name. 201 added, 200 exists.
export const addChannelRequestSchema = z.object({
  input: z.string().trim().min(1).max(CHANNEL_INPUT_MAX),
});
export type AddChannelRequest = z.infer<typeof addChannelRequestSchema>;
export const addChannelResponseSchema = z.object({
  status: z.enum(['added', 'exists']),
  channel: channelViewSchema,
});
export type AddChannelResponse = z.infer<typeof addChannelResponseSchema>;

// DELETE /api/app/channels — unlinks only; 404 not_found if not subscribed.
export const removeChannelRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
});
export type RemoveChannelRequest = z.infer<typeof removeChannelRequestSchema>;
export const removeChannelResponseSchema = z.object({ ok: z.literal(true) });
export type RemoveChannelResponse = z.infer<typeof removeChannelResponseSchema>;

// GET / PUT /api/app/interests — trimmed, control chars stripped, empty → null.
export const interestsResponseSchema = z.object({
  interests: z.string().nullable(),
  maxLength: z.number().int(),
});
export type InterestsResponse = z.infer<typeof interestsResponseSchema>;
export const putInterestsRequestSchema = z.object({
  // Raw input; the INTERESTS_MAX limit applies after cleaning (422 too_long).
  interests: z.string().max(INTERESTS_MAX * 2),
});
export type PutInterestsRequest = z.infer<typeof putInterestsRequestSchema>;

// GET /api/app/issues?before=<number>&limit=<1..50> — ready issues, newest first.
export const issuesQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(ARCHIVE_PAGE_MAX).default(20),
});
export type IssuesQuery = z.infer<typeof issuesQuerySchema>;
export const issuesResponseSchema = z.object({
  issues: z.array(issueSummarySchema),
  /** Pass as `before` for the next page; null = no more. */
  nextBefore: z.number().int().nullable(),
});
export type IssuesResponse = z.infer<typeof issuesResponseSchema>;

// POST /api/app/issues — no body. 202 started; then poll GET /api/app/issues/<id>.
export const buildResponseSchema = z.object({
  issue: issueStateSchema,
  quota: quotaSchema.nullable(),
});
export type BuildResponse = z.infer<typeof buildResponseSchema>;

// GET /api/app/issues/<id> — 404 not_found for a foreign or malformed id.
export const issueResponseSchema = z.object({ issue: issueStateSchema });
export type IssueResponse = z.infer<typeof issueResponseSchema>;

// DELETE /api/app/issues/<id> — soft delete of the user's own ready issue; idempotent.
// 404 not_found (foreign, malformed, failed, already gone for another user), 409 busy (in flight).
export const deleteIssueResponseSchema = z.object({ ok: z.literal(true) });
export type DeleteIssueResponse = z.infer<typeof deleteIssueResponseSchema>;

// POST /api/app/issues/<id>/share — no body. Pass the id to shareMessage(); never cache it.
// 404 not_found unless the issue is the user's own, ready and not deleted.
export const shareIssueResponseSchema = z.object({ preparedMessageId: z.string().min(1) });
export type ShareIssueResponse = z.infer<typeof shareIssueResponseSchema>;

// POST /api/app/issues/<id>/pdf — no body. Renders the PDF; the bot that signed the initData
// sends it to the user's chat with it. 404 as for share; 409 cannot_message when it may not write;
// 429 limit after DAILY_PDF_SENDS successful sends this Moscow day (the owner has no limit).
export const sendPdfResponseSchema = z.object({ ok: z.literal(true) });
export type SendPdfResponse = z.infer<typeof sendPdfResponseSchema>;

// GET /api/app/schedule — the same view as me.schedule.
// PUT /api/app/schedule — replaces the settings; 400 bad_request on a bad body (everyDays not in
// FREQUENCIES, hour outside 0..23, unknown time zone). enabled=true clears a pause and re-arms
// from the last ready issue (no issue yet → armed after the first one); enabled=false disarms.
export const scheduleResponseSchema = z.object({ schedule: scheduleViewSchema });
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
export const putScheduleRequestSchema = z.object({
  enabled: z.boolean(),
  everyDays: frequencySchema,
  hour: scheduleHourSchema,
  /** Omitted → keep the stored zone. */
  timeZone: z.string().min(1).max(TIME_ZONE_MAX).optional(),
  /**
   * true right after requestWriteAccess() resolved with status 'allowed' in this session;
   * counted only for initData signed by the prod bot.
   */
  writeAccessGranted: z.boolean().optional(),
});
export type PutScheduleRequest = z.infer<typeof putScheduleRequestSchema>;
