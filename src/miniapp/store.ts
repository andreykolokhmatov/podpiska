import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { listUserChannels, removeUserChannel, type UserChannelView } from '@/channels';
import type { Database } from '@/db';
import { issues, userChannels, users } from '@/db/schema';
import type { TimeRange } from '@/pipeline/store';

import type { MiniAppUser } from './auth';
import { QUOTA_EXEMPT_CODES, type IssueStateRow } from './status';

export interface AppUser {
  id: number;
  telegramId: number;
  firstName: string | null;
  username: string | null;
  onboardedAt: Date | null;
  interests: string | null;
}

export interface ReadyIssueRow {
  id: string;
  number: number;
  createdAt: Date;
  contentJson: unknown;
}

export interface ClaimInput {
  userId: number;
  period: TimeRange;
  /** Start of the quota day (00:00 MSK). */
  since: Date;
  /** In-flight issues created before this are reaped as failed('timeout'). */
  staleBefore: Date;
  /** null = no per-user limit (owner). */
  perUserLimit: number | null;
  globalLimit: number;
}

export type ClaimResult =
  /** used = quota builds today including this one (0 when perUserLimit is null). */
  | { kind: 'started'; issue: IssueStateRow; used: number }
  | { kind: 'busy'; issue: IssueStateRow }
  | { kind: 'limit'; used: number }
  | { kind: 'limit_global' }
  | { kind: 'no_channels' };

export interface AppStore {
  /** Creates or refreshes the user from initData (does not touch bot_blocked_at). */
  upsertUser(user: MiniAppUser): Promise<AppUser>;
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
  /** Only the user's own issue; `id` must already be a valid uuid. */
  getIssue(userId: number, id: string): Promise<IssueStateRow | undefined>;
  /** Builds since `since` that count toward the quota (exempt failures excluded). */
  countBuilds(userId: number, since: Date): Promise<number>;
  claimIssue(input: ClaimInput): Promise<ClaimResult>;
}

const userColumns = {
  id: users.id,
  telegramId: users.telegramId,
  firstName: users.firstName,
  username: users.username,
  onboardedAt: users.onboardedAt,
  interests: users.interestsPrompt,
};

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

// Mirrors countsTowardQuota(): failures that spent no LLM money are free.
const countsTowardQuota = sql`not (${issues.status} = 'failed' and split_part(coalesce(${issues.error}, ''), ':', 1) in (${sql.join(
  QUOTA_EXEMPT_CODES.map((code) => sql`${code}`),
  sql`, `,
)}))`;

const REAPED_ERROR = 'timeout: the build was interrupted';

export function createAppDbStore(db: Database): AppStore {
  return {
    async upsertUser(user) {
      const profile = { username: user.username, firstName: user.firstName };
      const [row] = await db
        .insert(users)
        .values({ telegramId: user.id, ...profile })
        .onConflictDoUpdate({ target: users.telegramId, set: profile })
        .returning(userColumns);
      if (!row) throw new Error('failed to upsert user');
      return row;
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
        .where(and(eq(issues.id, id), eq(issues.userId, userId)))
        .limit(1);
      return row;
    },

    async countBuilds(userId, since) {
      const [row] = await db
        .select({ value: count() })
        .from(issues)
        .where(and(eq(issues.userId, userId), gte(issues.createdAt, since), countsTowardQuota));
      return row?.value ?? 0;
    },

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
                countsTowardQuota,
              ),
            );
          used = row?.value ?? 0;
          if (used >= input.perUserLimit) return { kind: 'limit', used };
        }

        // Approximate under concurrency across users (no global lock): a soft spend cap.
        const [global] = await tx
          .select({ value: count() })
          .from(issues)
          .where(and(gte(issues.createdAt, input.since), countsTowardQuota));
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
          })
          .returning(stateColumns);
        if (!issue) throw new Error('failed to create issue');
        return { kind: 'started', issue, used: input.perUserLimit === null ? 0 : used + 1 };
      });
    },
  };
}
