import type { NotifyOutcome } from '@/bot/notify';

import type { ScheduleStore, ScheduleUser } from './store';
import { anchorToHour, DEFAULT_TZ, isValidTimeZone, nextIssueAt } from './time';

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

/** The next slot after a ready issue that ended at `base` (or after now). */
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
  const next = slotAfter(user, last.periodEnd, now);
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
