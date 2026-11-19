import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { listUserChannels, removeUserChannel, type UserChannelView } from '@/channels';
import type { Database } from '@/db';
import { issues, userChannels, users, type IssueTrigger, type PdfBot } from '@/db/schema';
import type { TimeRange } from '@/pipeline/store';
import type { ScheduleUser } from '@/schedule/store';

import type { MiniAppUser } from './auth';
import type { IssueErrorCode } from './contract';
import { FREE_FAILURE_CODES, QUOTA_EXEMPT_CODES, type IssueStateRow } from './status';

export interface AppUser {
  id: number;
  telegramId: number;
  firstName: string | null;
  username: string | null;
  onboardedAt: Date | null;
  interests: string | null;
  schedule: ScheduleUser;
}

export interface ReadyIssueRow {
  id: string;
  number: number;
  createdAt: Date;
  contentJson: unknown;
}

/** A Telegram file_id is valid only for the bot that uploaded the file. */
export interface PdfFileRef {
  fileId: string;
  bot: PdfBot;
}

export interface PdfIssueRow extends ReadyIssueRow {
  pdfFile: PdfFileRef | null;
}

export interface ClaimInput {
  userId: number;
  period: TimeRange;
  /** Only manual builds count toward perUserLimit; both count toward globalLimit. */
  trigger: IssueTrigger;
  /** Start of the quota day (00:00 MSK). */
  since: Date;
  /** In-flight issues created before this are reaped as failed('timeout'). */
  staleBefore: Date;
  /** null = no per-user limit (owner). */
  perUserLimit: number | null;
  globalLimit: number;
}

export type SoftDeleteResult = 'deleted' | 'not_found' | 'busy';

export type ClaimResult =
  /** used = quota builds today including this one (0 when perUserLimit is null). */
  | { kind: 'started'; issue: IssueStateRow; used: number }
  | { kind: 'busy'; issue: IssueStateRow }
  | { kind: 'limit'; used: number }
  | { kind: 'limit_global' }
  | { kind: 'no_channels' };

export interface AppStore {
  /**
   * Creates or refreshes the user from initData (does not touch bot_blocked_at); canNotifyAt
   * records that the prod bot may write to them.
   */
  upsertUser(user: MiniAppUser, options?: { canNotifyAt?: Date }): Promise<AppUser>;
  /** Read-only lookup: a reader of a shared issue must not become a user. */
  findUser(telegramId: number): Promise<AppUser | undefined>;
  /** Sets onboarded_at once; returns the stored value. */
  markOnboarded(userId: number, at: Date): Promise<Date>;
  setInterests(userId: number, interests: string | null): Promise<void>;
  countChannels(userId: number): Promise<number>;
  listChannels(userId: number): Promise<UserChannelView[]>;
  removeChannel(userId: number, username: string): Promise<boolean>;
  /** Ready issues, newest first; `before` is an exclusive issue-number cursor. */
  listReadyIssues(
    userId: number,
    page: { limit: number; before?: number },
  ): Promise<ReadyIssueRow[]>;
  /** The newest in-flight issue, stale or not. */
  latestInFlight(userId: number): Promise<IssueStateRow | undefined>;
  /** Only the user's own, non-deleted issue; `id` must already be a valid uuid. */
  getIssue(userId: number, id: string): Promise<IssueStateRow | undefined>;
  /** The user's own ready, non-deleted issue with its content and cached PDF (share, PDF). */
  getReadyIssue(userId: number, id: string): Promise<PdfIssueRow | undefined>;
  /**
   * Takes one PDF send of the MSK `day` atomically (a new day resets the counter); false when
   * `limit` sends were already taken that day.
   */
  claimPdfSend(userId: number, day: string, limit: number): Promise<boolean>;
  /** Gives back a send taken by claimPdfSend for `day` (a failed send costs nothing). */
  refundPdfSend(userId: number, day: string): Promise<void>;
  /**
   * Atomically takes up to `count` t.me channel lookups for the MSK `day` and returns how many
   * were granted: min(count, what is left of `limit`), 0 when none are left. A new day resets
   * the counter.
   */
  claimChannelLookups(userId: number, day: string, count: number, limit: number): Promise<number>;
  /** Gives back `count` lookups taken for `day` that were not spent. */
  refundChannelLookups(userId: number, day: string, count: number): Promise<void>;
  /** Remembers the uploaded PDF so the next send skips rendering. */
  savePdfFile(issueId: string, file: PdfFileRef): Promise<void>;
  /**
   * Hides the user's own ready issue for good; idempotent (a repeat call is 'deleted').
   * busy = still being built; not_found = no such issue of this user, or a failed one.
   */
  softDeleteIssue(userId: number, id: string): Promise<SoftDeleteResult>;
  /** Manual builds since `since` that count toward the quota (exempt failures excluded). */
  countBuilds(userId: number, since: Date): Promise<number>;
  /** Sets opened_at once on the user's own ready issue. */
  markOpened(userId: number, id: string): Promise<void>;
  claimIssue(input: ClaimInput): Promise<ClaimResult>;
}

const userColumns = {
  id: users.id,
  telegramId: users.telegramId,
  firstName: users.firstName,
  username: users.username,
  onboardedAt: users.onboardedAt,
  interests: users.interestsPrompt,
  enabled: users.scheduleEnabled,
  everyDays: users.scheduleEveryDays,
  hour: users.scheduleHour,
  timeZone: users.timezone,
  nextIssueAt: users.nextIssueAt,
  pausedAt: users.schedulePausedAt,
  canNotifyAt: users.canNotifyAt,
};

const toAppUser = (row: {
  id: number;
  telegramId: number;
  firstName: string | null;
  username: string | null;
  onboardedAt: Date | null;
  interests: string | null;
  enabled: boolean;
  everyDays: number;
  hour: number;
  timeZone: string | null;
  nextIssueAt: Date | null;
  pausedAt: Date | null;
  canNotifyAt: Date | null;
}): AppUser => ({
  id: row.id,
  telegramId: row.telegramId,
  firstName: row.firstName,
  username: row.username,
  onboardedAt: row.onboardedAt,
  interests: row.interests,
  schedule: {
    id: row.id,
    interests: row.interests,
    enabled: row.enabled,
    everyDays: row.everyDays,
    hour: row.hour,
    timeZone: row.timeZone,
    nextIssueAt: row.nextIssueAt,
    pausedAt: row.pausedAt,
    canNotifyAt: row.canNotifyAt,
  },
});

const stateColumns = {
  id: issues.id,
  status: issues.status,
  error: issues.error,
  number: issues.number,
  digestsDone: issues.digestsDone,
  digestsTotal: issues.digestsTotal,
  createdAt: issues.createdAt,
  stats: issues.statsJson,
};

const IN_FLIGHT = ['pending', 'collecting', 'digesting', 'composing'] as const;

// Scheduled builds never use up the user's "build now" presses.
const manualOnly = sql`${issues.trigger} = 'manual'`;

const notFailedWith = (codes: readonly IssueErrorCode[]) =>
  sql`not (${issues.status} = 'failed' and split_part(coalesce(${issues.error}, ''), ':', 1) in (${sql.join(
    codes.map((code) => sql`${code}`),
    sql`, `,
  )}))`;

// Built from the same constants as countsTowardQuota() / countsTowardSpend(), so they cannot drift.
const countsTowardQuota = notFailedWith(QUOTA_EXEMPT_CODES);
const countsTowardSpend = notFailedWith(FREE_FAILURE_CODES);

// pg_advisory_xact_lock key serialising the global-cap check and the insert across all users.
const GLOBAL_CAP_LOCK = 0x70647370;

const REAPED_ERROR = 'timeout: the build was interrupted';

export function createAppDbStore(db: Database): AppStore {
  return {
    async upsertUser(user, options = {}) {
      const profile = {
        username: user.username,
        firstName: user.firstName,
        ...(options.canNotifyAt === undefined ? {} : { canNotifyAt: options.canNotifyAt }),
      };
      const [row] = await db
        .insert(users)
        .values({ telegramId: user.id, ...profile })
        .onConflictDoUpdate({ target: users.telegramId, set: profile })
        .returning(userColumns);
      if (!row) throw new Error('failed to upsert user');
      return toAppUser(row);
    },

    async findUser(telegramId) {
      const [row] = await db
        .select(userColumns)
        .from(users)
        .where(eq(users.telegramId, telegramId))
        .limit(1);
      return row === undefined ? undefined : toAppUser(row);
    },

    async markOnboarded(userId, at) {
      const [row] = await db
        .update(users)
        .set({ onboardedAt: sql`coalesce(${users.onboardedAt}, ${at.toISOString()}::timestamptz)` })
        .where(eq(users.id, userId))
        .returning({ onboardedAt: users.onboardedAt });
      if (!row?.onboardedAt) throw new Error(`user ${userId} not found`);
      return row.onboardedAt;
    },

    async setInterests(userId, interests) {
      await db.update(users).set({ interestsPrompt: interests }).where(eq(users.id, userId));
    },

    async countChannels(userId) {
      const [row] = await db
        .select({ value: count() })
        .from(userChannels)
        .where(eq(userChannels.userId, userId));
      return row?.value ?? 0;
    },

    listChannels: (userId) => listUserChannels(db, userId),
    removeChannel: (userId, username) => removeUserChannel(db, userId, username),

    async listReadyIssues(userId, page) {
      const rows = await db
        .select({
          id: issues.id,
          number: issues.number,
          createdAt: issues.createdAt,
          contentJson: issues.contentJson,
        })
        .from(issues)
        .where(
          and(
            eq(issues.userId, userId),
            eq(issues.status, 'ready'),
            isNotNull(issues.number),
            isNull(issues.deletedAt),
            ...(page.before === undefined ? [] : [lt(issues.number, page.before)]),
          ),
        )
        .orderBy(desc(issues.number))
        .limit(page.limit);
      return rows.flatMap((row) => (row.number === null ? [] : [{ ...row, number: row.number }]));
    },

    async latestInFlight(userId) {
      const [row] = await db
        .select(stateColumns)
        .from(issues)
        .where(and(eq(issues.userId, userId), inArray(issues.status, [...IN_FLIGHT])))
        .orderBy(desc(issues.createdAt))
        .limit(1);
      return row;
    },

    async getIssue(userId, id) {
      const [row] = await db
        .select(stateColumns)
        .from(issues)
        .where(and(eq(issues.id, id), eq(issues.userId, userId), isNull(issues.deletedAt)))
        .limit(1);
      return row;
    },

    async softDeleteIssue(userId, id) {
      // Only ready rows: the pipeline never writes to a ready issue again, so this cannot race
      // with a running build. coalesce keeps the first deletion time on a repeat call.
      const [row] = await db
        .update(issues)
        .set({ deletedAt: sql`coalesce(${issues.deletedAt}, now())` })
        .where(and(eq(issues.id, id), eq(issues.userId, userId), eq(issues.status, 'ready')))
        .returning({ id: issues.id });
      if (row !== undefined) return 'deleted';
      const [other] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(eq(issues.id, id), eq(issues.userId, userId), inArray(issues.status, [...IN_FLIGHT])),
        )
        .limit(1);
      return other === undefined ? 'not_found' : 'busy';
    },

    async getReadyIssue(userId, id) {
      const [row] = await db
        .select({
          id: issues.id,
          number: issues.number,
          createdAt: issues.createdAt,
          contentJson: issues.contentJson,
          pdfFileId: issues.pdfFileId,
          pdfFileBot: issues.pdfFileBot,
        })
        .from(issues)
        .where(
          and(
            eq(issues.id, id),
            eq(issues.userId, userId),
            eq(issues.status, 'ready'),
            isNull(issues.deletedAt),
          ),
        )
        .limit(1);
      if (row === undefined || row.number === null) return undefined;
      const { pdfFileId, pdfFileBot, ...rest } = row;
      return {
        ...rest,
        number: row.number,
        pdfFile:
          pdfFileId !== null && pdfFileBot !== null ? { fileId: pdfFileId, bot: pdfFileBot } : null,
      };
    },

    async claimPdfSend(userId, day, limit) {
      // One statement: concurrent taps cannot both pass the check. SET reads the old row values.
      const [row] = await db
        .update(users)
        .set({
          pdfSendsCount: sql`case when ${users.pdfSendsDay} = ${day}::date then ${users.pdfSendsCount} + 1 else 1 end`,
          pdfSendsDay: day,
        })
        .where(
          and(
            eq(users.id, userId),
            sql`(${users.pdfSendsDay} is distinct from ${day}::date or ${users.pdfSendsCount} < ${limit})`,
          ),
        )
        .returning({ count: users.pdfSendsCount });
      return row !== undefined;
    },

    async refundPdfSend(userId, day) {
      await db
        .update(users)
        .set({ pdfSendsCount: sql`greatest(${users.pdfSendsCount} - 1, 0)` })
        .where(and(eq(users.id, userId), eq(users.pdfSendsDay, day)));
    },

    async claimChannelLookups(userId, day, count, limit) {
      if (count <= 0) return 0;
      // Row lock: concurrent batches see each other's grants and never exceed the limit together.
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ day: users.channelLookupsDay, count: users.channelLookupsCount })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (row === undefined) return 0;
        const used = row.day === day ? row.count : 0;
        const granted = Math.max(0, Math.min(count, limit - used));
        if (granted === 0) return 0;
        await tx
          .update(users)
          .set({ channelLookupsDay: day, channelLookupsCount: used + granted })
          .where(eq(users.id, userId));
        return granted;
      });
    },

    async refundChannelLookups(userId, day, count) {
      if (count <= 0) return;
      await db
        .update(users)
        .set({ channelLookupsCount: sql`greatest(${users.channelLookupsCount} - ${count}, 0)` })
        .where(and(eq(users.id, userId), eq(users.channelLookupsDay, day)));
    },

    async savePdfFile(issueId, file) {
      await db
        .update(issues)
        .set({ pdfFileId: file.fileId, pdfFileBot: file.bot })
        .where(eq(issues.id, issueId));
    },

    // Deleted issues still count: deleting must not refund the daily quota.
    async countBuilds(userId, since) {
      const [row] = await db
        .select({ value: count() })
        .from(issues)
        .where(
          and(
            eq(issues.userId, userId),
            gte(issues.createdAt, since),
            manualOnly,
            countsTowardQuota,
          ),
        );
      return row?.value ?? 0;
    },

    async markOpened(userId, id) {
      await db
        .update(issues)
        .set({ openedAt: sql`coalesce(${issues.openedAt}, now())` })
        .where(
          and(
            eq(issues.id, id),
            eq(issues.userId, userId),
            eq(issues.status, 'ready'),
            isNull(issues.deletedAt),
            isNull(issues.openedAt),
          ),
        );
    },

    // No deleted_at filter anywhere in the claim: a deleted issue still holds its quota slot
    // and its share of the global cap, and only ready issues can be deleted (never in-flight).
    async claimIssue(input) {
      return db.transaction(async (tx) => {
        // Serialises claims of one user: two taps cannot both pass the checks below.
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update');
        if (!user) throw new Error(`user ${input.userId} not found`);

        await tx
          .update(issues)
          .set({ status: 'failed', error: REAPED_ERROR })
          .where(
            and(
              eq(issues.userId, input.userId),
              inArray(issues.status, [...IN_FLIGHT]),
              lt(issues.createdAt, input.staleBefore),
            ),
          );

        const [busy] = await tx
          .select(stateColumns)
          .from(issues)
          .where(and(eq(issues.userId, input.userId), inArray(issues.status, [...IN_FLIGHT])))
          .orderBy(desc(issues.createdAt))
          .limit(1);
        if (busy) return { kind: 'busy', issue: busy };

        let used = 0;
        if (input.perUserLimit !== null) {
          const [row] = await tx
            .select({ value: count() })
            .from(issues)
            .where(
              and(
                eq(issues.userId, input.userId),
                gte(issues.createdAt, input.since),
                manualOnly,
                countsTowardQuota,
              ),
            );
          used = row?.value ?? 0;
          if (used >= input.perUserLimit) return { kind: 'limit', used };
        }

        // Held until commit, so two users' claims cannot both see the last free global slot.
        // Always taken after the user row lock: one lock order everywhere, no deadlock.
        await tx.execute(sql`select pg_advisory_xact_lock(${GLOBAL_CAP_LOCK})`);
        const [global] = await tx
          .select({ value: count() })
          .from(issues)
          .where(and(gte(issues.createdAt, input.since), countsTowardSpend));
        if ((global?.value ?? 0) >= input.globalLimit) return { kind: 'limit_global' };

        const [channelCount] = await tx
          .select({ value: count() })
          .from(userChannels)
          .where(eq(userChannels.userId, input.userId));
        if ((channelCount?.value ?? 0) === 0) return { kind: 'no_channels' };

        const [issue] = await tx
          .insert(issues)
          .values({
            userId: input.userId,
            periodStart: input.period.start,
            periodEnd: input.period.end,
            status: 'pending',
            trigger: input.trigger,
          })
          .returning(stateColumns);
        if (!issue) throw new Error('failed to create issue');
        return { kind: 'started', issue, used: input.perUserLimit === null ? 0 : used + 1 };
      });
    },
  };
}
