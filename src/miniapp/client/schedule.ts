import { FREQUENCIES, TIME_ZONE_MAX, type Frequency, type ScheduleView } from '@/miniapp/contract';

import { t } from './texts';

export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** «08:00» for the picker. */
export const hourOption = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** «8:00» in running text. */
export const hourLabel = (hour: number) => `${hour}:00`;

export const isFrequency = (n: number): n is Frequency =>
  (FREQUENCIES as readonly number[]).includes(n);

/** The device's IANA zone, or null when Intl cannot tell (the server keeps its stored one). */
export function clientTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length <= TIME_ZONE_MAX ? zone : null;
  } catch {
    return null;
  }
}

function zoneDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** «сегодня, 8:00» / «завтра, 8:00» / «пн, 8:00», all in the schedule's zone. */
export function whenLabel(at: Date, timeZone: string, now: Date = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at),
  );
  const day = zoneDate(at, timeZone);
  let prefix: string;
  if (day === zoneDate(now, timeZone)) prefix = t.schedule.today;
  else if (day === zoneDate(new Date(now.getTime() + 86_400_000), timeZone)) {
    prefix = t.schedule.tomorrow;
  } else {
    prefix = new Intl.DateTimeFormat('ru', { timeZone, weekday: 'short' }).format(at);
  }
  return `${prefix}, ${hourLabel(hour)}`;
}

/** The hub's one-line schedule summary. */
export function nextIssueLine(view: ScheduleView, now: Date = new Date()): string {
  if (!view.enabled) return t.schedule.off;
  if (!view.canNotify) return t.schedule.needPermission;
  if (view.paused) return t.schedule.pausedLine;
  if (view.nextIssueAt === null) return t.schedule.needIssue;
  const when = whenLabel(new Date(view.nextIssueAt), view.timeZone, now);
  return `${when} · ${t.schedule.frequencyShort[view.everyDays]}`;
}

/** «Омск (UTC+6)»; falls back to the IANA name where Intl has no local name. */
export function timeZoneName(timeZone: string, now: Date = new Date()): string {
  const part = (style: 'shortGeneric' | 'shortOffset') => {
    try {
      return new Intl.DateTimeFormat('ru', { timeZone, timeZoneName: style })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value;
    } catch {
      return undefined;
    }
  };
  const offset = part('shortOffset')?.replace(/^GMT/, 'UTC');
  const generic = part('shortGeneric');
  const name = generic && !/^GMT|^UTC/.test(generic) ? generic : timeZone.replaceAll('_', ' ');
  return offset ? `${name} (${offset === 'UTC' ? 'UTC+0' : offset})` : name;
}

export interface ScheduleDraft {
  enabled: boolean;
  everyDays: Frequency;
  hour: number;
}

/**
 * What the switch shows: on only when the schedule really runs or waits for the first issue.
 * A paused schedule or one without the bot's permission reads as off, so «включите» makes sense.
 */
export const draftFrom = (view: ScheduleView): ScheduleDraft => ({
  enabled: view.enabled && !view.paused && view.canNotify,
  everyDays: view.everyDays,
  hour: view.hour,
});

export const sameDraft = (a: ScheduleDraft, b: ScheduleDraft) =>
  a.enabled === b.enabled && a.everyDays === b.everyDays && a.hour === b.hour;

/** The note under the switch for the saved state (the draft is unchanged). */
export function scheduleNote(view: ScheduleView, now: Date = new Date()): string {
  if (view.paused && view.canNotify) return t.schedule.pausedNote;
  if (!view.canNotify && view.enabled) return t.schedule.permissionNote;
  if (!view.enabled) return t.schedule.offNote;
  if (view.nextIssueAt === null) return t.schedule.firstIssueNote;
  return t.schedule.nextNote(whenLabel(new Date(view.nextIssueAt), view.timeZone, now));
}
