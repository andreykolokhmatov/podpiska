import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  sql,
} from 'drizzle-orm';

import type { Database } from '@/db';
import { channelDigests, channels, issues, posts, userChannels, users } from '@/db/schema';
import type { IssueStatus, IssueTrigger } from '@/db/schema';

import { StatusTransitionError } from './errors';
import type { StoredDigest } from './digest-schema';

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface DayPost {
  id: number;
  tgPostId: number;
  text: string;
  publishedAt: Date;
}

export interface DigestRow {
  channelId: number;
  day: string;
  summary: unknown;
  model: string;
  inputHash: string;
  /** When the digest was computed; a digest computed after its day ended is final. */
  computedAt: Date;
}

export interface DigestStore {
  getDigest(channelId: number, day: string): Promise<DigestRow | undefined>;
  saveDigest(row: DigestRow & { summary: StoredDigest }): Promise<void>;
  /** Posts published in the range with non-blank text, ordered by tg_post_id. */
  getChannelDayPosts(channelId: number, range: TimeRange): Promise<DayPost[]>;
}

export interface UserChannelRow {
  id: number;
  username: string;
  title: string | null;
}

export interface PostMeta {
  id: number;
  channelId: number;
  tgPostId: number;
  publishedAt: Date;
}

export interface IssueRecord {
  id: string;
  userId: number;
  status: IssueStatus;
  periodStart: Date;
  periodEnd: Date;
}

export interface IssueProgress {
  digestsTotal?: number;
  digestsDone?: number;
  stats?: unknown;
}

export interface IssueStore {
  /** trigger defaults to 'manual'. */
  create(userId: number, period: TimeRange, trigger?: IssueTrigger): Promise<IssueRecord>;
  /** Moves from→to atomically; throws StatusTransitionError if the issue is not in `from`. */
  transition(id: string, from: IssueStatus, to: IssueStatus, patch?: IssueProgress): Promise<void>;
  progress(id: string, patch: IssueProgress): Promise<void>;
  /** Marks any non-final issue failed; a ready/failed issue is left untouched. */
  fail(id: string, message: string, stats: unknown): Promise<void>;
  /** composing→ready; number = user's max (deleted included) + 1, inside the transaction. */
  complete(
    id: string,
    build: (number: number) => { content: unknown; stats: unknown },
  ): Promise<number>;
  /** period_end of the user's latest ready, non-deleted issue. */
  lastReadyPeriodEnd(userId: number): Promise<Date | undefined>;
  getUserChannels(userId: number): Promise<UserChannelRow[]>;
  getPostsMeta(ids: readonly number[]): Promise<PostMeta[]>;
  periodCounts(userId: number, range: TimeRange): Promise<{ messages: number; channels: number }>;
}

const hasText = sql`${posts.text} is not null and btrim(${posts.text}) <> ''`;

export function createDigestDbStore(db: Database): DigestStore {
  return {
    async getDigest(channelId, day) {
      const [row] = await db
        .select({
          channelId: channelDigests.channelId,
          day: channelDigests.day,
          summary: channelDigests.summaryJson,
          model: channelDigests.model,
          inputHash: channelDigests.inputHash,
          computedAt: channelDigests.computedAt,
        })
        .from(channelDigests)
        .where(and(eq(channelDigests.channelId, channelId), eq(channelDigests.day, day)));
      return row;
    },
    async saveDigest(row) {
      await db
        .insert(channelDigests)
        .values({
          channelId: row.channelId,
          day: row.day,
          summaryJson: row.summary,
          model: row.model,
          inputHash: row.inputHash,
          computedAt: row.computedAt,
        })
        .onConflictDoUpdate({
          target: [channelDigests.channelId, channelDigests.day],
          set: {
            summaryJson: row.summary,
            model: row.model,
            inputHash: row.inputHash,
            computedAt: row.computedAt,
          },
        });
    },
    async getChannelDayPosts(channelId, range) {
      const rows = await db
        .select({
          id: posts.id,
          tgPostId: posts.tgPostId,
          text: posts.text,
          publishedAt: posts.publishedAt,
        })
        .from(posts)
        .where(
          and(
            eq(posts.channelId, channelId),
            gte(posts.publishedAt, range.start),
            lt(posts.publishedAt, range.end),
            hasText,
          ),
        )
        .orderBy(asc(posts.tgPostId));
      return rows.map((row) => ({ ...row, text: row.text ?? '' }));
    },
  };
}

const UNIQUE_VIOLATION = '23505';
const COMPLETE_ATTEMPTS = 3;

const pgCode = (error: unknown): string | undefined => {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') return current.code;
  }
  return undefined;
};

export function createIssueDbStore(db: Database): IssueStore {
  const patchColumns = (patch: IssueProgress = {}) => ({
    ...(patch.digestsTotal === undefined ? {} : { digestsTotal: patch.digestsTotal }),
    ...(patch.digestsDone === undefined ? {} : { digestsDone: patch.digestsDone }),
    ...(patch.stats === undefined ? {} : { statsJson: patch.stats }),
  });

  return {
    async create(userId, period, trigger = 'manual') {
      const [row] = await db
        .insert(issues)
        .values({
          userId,
          periodStart: period.start,
          periodEnd: period.end,
          status: 'pending',
          trigger,
        })
        .returning({
          id: issues.id,
          userId: issues.userId,
          status: issues.status,
          periodStart: issues.periodStart,
          periodEnd: issues.periodEnd,
        });
      if (!row) throw new Error('failed to create issue');
      return row;
    },
    async transition(id, from, to, patch) {
      const rows = await db
        .update(issues)
        .set({ status: to, ...patchColumns(patch) })
        .where(and(eq(issues.id, id), eq(issues.status, from)))
        .returning({ id: issues.id });
      if (rows.length === 0) throw new StatusTransitionError(id, from, to);
    },
    async progress(id, patch) {
      await db.update(issues).set(patchColumns(patch)).where(eq(issues.id, id));
    },
    async fail(id, message, stats) {
      await db
        .update(issues)
        .set({ status: 'failed', error: message, statsJson: stats })
        .where(and(eq(issues.id, id), notInArray(issues.status, ['ready', 'failed'])));
    },
    async complete(id, build) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            const [issue] = await tx
              .select({ userId: issues.userId, status: issues.status })
              .from(issues)
              .where(eq(issues.id, id));
            if (issue?.status !== 'composing') {
              throw new StatusTransitionError(id, 'composing', 'ready');
            }
            // Serialises number assignment per user.
            await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, issue.userId))
              .for('update');
            // Deleted issues are included on purpose: their numbers stay taken, otherwise the
            // unique (user_id, number) constraint would collide with the soft-deleted row.
            const [max] = await tx
              .select({ value: sql<number>`coalesce(max(${issues.number}), 0)::int` })
              .from(issues)
              .where(eq(issues.userId, issue.userId));
            const number = (max?.value ?? 0) + 1;
            const { content, stats } = build(number);
            const rows = await tx
              .update(issues)
              .set({ status: 'ready', number, contentJson: content, statsJson: stats, error: null })
              .where(and(eq(issues.id, id), eq(issues.status, 'composing')))
              .returning({ id: issues.id });
            if (rows.length === 0) throw new StatusTransitionError(id, 'composing', 'ready');
            return number;
          });
        } catch (error) {
          if (pgCode(error) !== UNIQUE_VIOLATION || attempt >= COMPLETE_ATTEMPTS) throw error;
        }
      }
    },
    async lastReadyPeriodEnd(userId) {
      const [row] = await db
        .select({ periodEnd: issues.periodEnd })
        .from(issues)
        // A deleted issue does not cover its period: the next build re-covers it (owner decision).
        .where(and(eq(issues.userId, userId), eq(issues.status, 'ready'), isNull(issues.deletedAt)))
        .orderBy(desc(issues.periodEnd))
        .limit(1);
      return row?.periodEnd;
    },
    async getUserChannels(userId) {
      return db
        .select({ id: channels.id, username: channels.username, title: channels.title })
        .from(userChannels)
        .innerJoin(channels, eq(channels.id, userChannels.channelId))
        .where(eq(userChannels.userId, userId))
        .orderBy(asc(channels.username));
    },
    async getPostsMeta(ids) {
      if (ids.length === 0) return [];
      return db
        .select({
          id: posts.id,
          channelId: posts.channelId,
          tgPostId: posts.tgPostId,
          publishedAt: posts.publishedAt,
        })
        .from(posts)
        .where(inArray(posts.id, [...ids]));
    },
    async periodCounts(userId, range) {
      const [row] = await db
        .select({
          messages: sql<number>`count(*)::int`,
          channels: sql<number>`count(distinct ${posts.channelId})::int`,
        })
        .from(posts)
        .innerJoin(userChannels, eq(userChannels.channelId, posts.channelId))
        .where(
          and(
            eq(userChannels.userId, userId),
            // Issue windows are (start, end], like resolve.
            gt(posts.publishedAt, range.start),
            lte(posts.publishedAt, range.end),
            hasText,
          ),
        );
      return { messages: row?.messages ?? 0, channels: row?.channels ?? 0 };
    },
  };
}

/** Dev/CLI helper until real users arrive with the bot (step 4). */
export async function upsertDevUser(
  db: Database,
  telegramId: number,
  interests: string | undefined,
): Promise<{ id: number; interests: string | null }> {
  const [row] = await db
    .insert(users)
    .values({ telegramId, ...(interests === undefined ? {} : { interestsPrompt: interests }) })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: interests === undefined ? { telegramId } : { interestsPrompt: interests },
    })
    .returning({ id: users.id, interests: users.interestsPrompt });
  if (!row) throw new Error('failed to upsert user');
  return row;
}

/** Replaces the user's channel set; unknown usernames get a bare channels row. */
export async function replaceUserChannels(
  db: Database,
  userId: number,
  usernames: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    if (usernames.length > 0) {
      await tx
        .insert(channels)
        .values(usernames.map((username) => ({ username })))
        .onConflictDoNothing({ target: channels.username });
    }
    const rows =
      usernames.length === 0
        ? []
        : await tx
            .select({ id: channels.id })
            .from(channels)
            .where(inArray(channels.username, [...usernames]));
    await tx.delete(userChannels).where(eq(userChannels.userId, userId));
    if (rows.length > 0) {
      await tx.insert(userChannels).values(rows.map((row) => ({ userId, channelId: row.id })));
    }
  });
}
