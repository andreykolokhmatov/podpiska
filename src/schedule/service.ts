import type { NotifyOutcome } from '@/bot/notify';

import type { ScheduleStore, ScheduleUser } from './store';
import { anchorToHour, DEFAULT_TZ, firstHourAtOrAfter, isValidTimeZone, nextIssueAt } from './time';

const DAY_MS = 86_400_000;

/**
 * A scheduled run this soon after a manual issue is skipped (it would be a near-empty paper).
 * Slots are armed past it, so the hub never promises an issue the run would skip.
 */
export const FRESH_GAP_MS = 3 * 3_600_000;

export const zoneOf = (user: Pick<ScheduleUser, 'timeZone'>): string =>
  user.timeZone !== null && isValidTimeZone(user.timeZone) ? user.timeZone : DEFAULT_TZ;

/** Every condition but next_issue_at under which the schedule may be armed. */
export const mayActivate = (
  user: Pick<ScheduleUser, 'enabled' | 'pausedAt' | 'canNotifyAt'>,
): boolean => user.enabled && user.pausedAt === null && user.canNotifyAt !== null;

/** The slot after a claimed one; a retry slot is anchored back to its scheduled hour. */
export const slotAfterSlot = (
  user: Pick<ScheduleUser, 'everyDays' | 'hour' | 'timeZone'>,
  slot: Date,
  now: Date,
): Date => slotAfter(user, anchorToHour(slot, user.hour, zoneOf(user)), now);

/**
 * The first slot after a ready issue that ended at `lastEnd`: the first hour:00 at least one
 * period minus a day plus FRESH_GAP later. Daily at 6:00 after an issue at 23:30 → 6:00 next
 * morning; weekly → a week later. Never in the past.
 */
export const slotAfterIssue = (
  user: Pick<ScheduleUser, 'everyDays' | 'hour' | 'timeZone'>,
  lastEnd: Date,
  now: Date,
): Date => {
  const zone = zoneOf(user);
  const earliest = new Date(lastEnd.getTime() + (user.everyDays - 1) * DAY_MS + FRESH_GAP_MS);
  const after = new Date(Math.max(earliest.getTime(), now.getTime() + 1));
  return firstHourAtOrAfter(after, user.hour, zone);
};

/** Date-based next slot: base's calendar day + everyDays at hour:00 (or the next hour:00). */
export const slotAfter = (
  user: Pick<ScheduleUser, 'everyDays' | 'hour' | 'timeZone'>,
  base: Date,
  now: Date,
): Date =>
  nextIssueAt({ base, everyDays: user.everyDays, hour: user.hour, timeZone: zoneOf(user), now });

/**
 * Arms a schedule that may run but has no slot yet, counting from the last ready issue; a user
 * who never got an issue stays unarmed (spends nothing). Returns the resulting next_issue_at.
 */
export async function ensureActive(
  store: Pick<ScheduleStore, 'recentReady' | 'activate'>,
  user: ScheduleUser,
  now: Date,
): Promise<Date | null> {
  if (user.nextIssueAt !== null || !mayActivate(user)) return user.nextIssueAt;
  const [last] = await store.recentReady(user.id, 1);
  if (last === undefined) return null;
  const next = slotAfterIssue(user, last.periodEnd, now);
  return (await store.activate(user.id, next)) ? next : null;
}

/** unreachable = the bot may not write to the user: stop auto builds until they allow it again. */
export async function applyNotifyOutcome(
  store: Pick<ScheduleStore, 'markUnreachable'>,
  userId: number,
  outcome: NotifyOutcome,
  now: Date,
): Promise<void> {
  if (outcome === 'unreachable') await store.markUnreachable(userId, now);
}
