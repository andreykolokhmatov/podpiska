import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@/db';
import { issues, userChannels, users, type IssueTrigger } from '@/db/schema';

export interface ScheduleUser {
  id: number;
  interests: string | null;
  enabled: boolean;
  everyDays: number;
  hour: number;
  /** Stored IANA zone; null = DEFAULT_TZ. */
  timeZone: string | null;
  nextIssueAt: Date | null;
  pausedAt: Date | null;
  canNotifyAt: Date | null;
}

export interface ScheduleSettingsPatch {
  enabled: boolean;
  everyDays: number;
  hour: number;
  timeZone: string | null;
  nextIssueAt: Date | null;
  /** Also clears schedule_paused_at (re-enabling). */
  clearPause: boolean;
  /** A fresh write-access grant; undefined leaves can_notify_at as is. */
  canNotifyAt?: Date;
}

export interface RecentIssue {
  trigger: IssueTrigger;
  openedAt: Date | null;
  periodEnd: Date;
}

export interface ScheduleStore {
  get(userId: number): Promise<ScheduleUser | undefined>;
  update(userId: number, patch: ScheduleSettingsPatch): Promise<void>;
  setTimezone(userId: number, timeZone: string): Promise<void>;
  /**
   * Sets next_issue_at only while it is null and the schedule may run (enabled, not paused,
   * can notify); false when any of that no longer holds.
   */
  activate(userId: number, next: Date): Promise<boolean>;
  /** Users whose slot has come, oldest slot first. */
  dueUsers(now: Date, limit: number): Promise<number[]>;
  /**
   * Atomically moves a due slot forward: locks the row, re-checks every due condition, stores
   * next(user). undefined = not due (already claimed by a parallel run, disabled, paused...).
   */
  claimSlot(
    userId: number,
    now: Date,
    next: (user: ScheduleUser & { nextIssueAt: Date }) => Date,
  ): Promise<{ user: ScheduleUser; slot: Date; next: Date } | undefined>;
  /** Puts the old slot back, unless the user changed the schedule in between. */
  rollbackSlot(userId: number, slot: Date, claimed: Date): Promise<void>;
  /** Pulls the slot in to `at` (never pushes it out); no-op while the schedule is off. */
  retrySoon(userId: number, at: Date): Promise<void>;
  /** Ready, non-deleted issues, latest period first. */
  recentReady(userId: number, limit: number): Promise<RecentIssue[]>;
  /** Sets schedule_paused_at once; true only for the call that paused it. */
  pause(userId: number, at: Date): Promise<boolean>;
  /** Scheduled issues created at or after `since` (attempts at the current slot incl. retries). */
  countSlotAttempts(userId: number, since: Date): Promise<number>;
  /** The bot cannot write to the user: forget the permission and pause. */
  markUnreachable(userId: number, at: Date): Promise<void>;
}

const columns = {
  id: users.id,
  interests: users.interestsPrompt,
  enabled: users.scheduleEnabled,
  everyDays: users.scheduleEveryDays,
  hour: users.scheduleHour,
  timeZone: users.timezone,
  nextIssueAt: users.nextIssueAt,
  pausedAt: users.schedulePausedAt,
  canNotifyAt: users.canNotifyAt,
};

/** Every condition but the slot time under which an automatic build may run. */
const mayRun = and(
  eq(users.scheduleEnabled, true),
  isNull(users.schedulePausedAt),
  isNotNull(users.canNotifyAt),
  isNull(users.botBlockedAt),
);

const hasChannel = sql`exists (select 1 from ${userChannels} where ${userChannels.userId} = ${users.id})`;

export function createScheduleDbStore(db: Database): ScheduleStore {
  return {
    async get(userId) {
      const [row] = await db.select(columns).from(users).where(eq(users.id, userId)).limit(1);
      return row;
    },

    async update(userId, patch) {
      await db
        .update(users)
        .set({
          scheduleEnabled: patch.enabled,
          scheduleEveryDays: patch.everyDays,
          scheduleHour: patch.hour,
          timezone: patch.timeZone,
          nextIssueAt: patch.nextIssueAt,
          ...(patch.clearPause ? { schedulePausedAt: null } : {}),
          ...(patch.canNotifyAt === undefined ? {} : { canNotifyAt: patch.canNotifyAt }),
        })
        .where(eq(users.id, userId));
      if (patch.clearPause) {
        // Resuming acknowledges the unread auto issues; otherwise the same three would pause the
        // schedule again on its very next run.
        await db
          .update(issues)
          .set({ openedAt: sql`coalesce(${issues.openedAt}, now())` })
          .where(
            and(
              eq(issues.userId, userId),
              eq(issues.trigger, 'scheduled'),
              isNull(issues.openedAt),
            ),
          );
      }
    },

    async setTimezone(userId, timeZone) {
      await db.update(users).set({ timezone: timeZone }).where(eq(users.id, userId));
    },

    async activate(userId, next) {
      const rows = await db
        .update(users)
        .set({ nextIssueAt: next })
        .where(
          and(
            eq(users.id, userId),
            isNull(users.nextIssueAt),
            eq(users.scheduleEnabled, true),
            isNull(users.schedulePausedAt),
            isNotNull(users.canNotifyAt),
          ),
        )
        .returning({ id: users.id });
      return rows.length > 0;
    },

    async dueUsers(now, limit) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(lte(users.nextIssueAt, now), mayRun, hasChannel))
        .orderBy(asc(users.nextIssueAt))
        .limit(limit);
      return rows.map((row) => row.id);
    },

    async claimSlot(userId, now, next) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select(columns)
          .from(users)
          .where(and(eq(users.id, userId), lte(users.nextIssueAt, now), mayRun))
          .for('update');
        if (row?.nextIssueAt == null) return undefined;
        const slot = row.nextIssueAt;
        const claimed = next({ ...row, nextIssueAt: slot });
        await tx.update(users).set({ nextIssueAt: claimed }).where(eq(users.id, userId));
        return { user: row, slot, next: claimed };
      });
    },

    async rollbackSlot(userId, slot, claimed) {
      await db
        .update(users)
        .set({ nextIssueAt: slot })
        .where(and(eq(users.id, userId), eq(users.nextIssueAt, claimed)));
    },

    async retrySoon(userId, at) {
      await db
        .update(users)
        .set({ nextIssueAt: sql`least(${users.nextIssueAt}, ${at.toISOString()}::timestamptz)` })
        .where(and(eq(users.id, userId), isNotNull(users.nextIssueAt), mayRun));
    },

    async recentReady(userId, limit) {
      return db
        .select({
          trigger: issues.trigger,
          openedAt: issues.openedAt,
          periodEnd: issues.periodEnd,
        })
        .from(issues)
        .where(and(eq(issues.userId, userId), eq(issues.status, 'ready'), isNull(issues.deletedAt)))
        .orderBy(desc(issues.periodEnd))
        .limit(limit);
    },

    async pause(userId, at) {
      const rows = await db
        .update(users)
        .set({ schedulePausedAt: at })
        .where(and(eq(users.id, userId), isNull(users.schedulePausedAt)))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    async countSlotAttempts(userId, since) {
      const [row] = await db
        .select({ value: count() })
        .from(issues)
        .where(
          and(
            eq(issues.userId, userId),
            eq(issues.trigger, 'scheduled'),
            gte(issues.createdAt, since),
          ),
        );
      return row?.value ?? 0;
    },

    async markUnreachable(userId, at) {
      await db
        .update(users)
        .set({
          canNotifyAt: null,
          schedulePausedAt: sql`coalesce(${users.schedulePausedAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(eq(users.id, userId));
    },
  };
}
