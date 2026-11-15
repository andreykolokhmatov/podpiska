import { TIME_ZONE_MAX } from '@/miniapp/contract';

export const DEFAULT_TZ = 'Europe/Moscow';

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** An IANA zone Intl knows, e.g. Europe/Berlin; anything else (incl. over 64 chars) is false. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TIME_ZONE_MAX) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedDateTime {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedDateTime & { second: number } {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** UTC offset of the zone at an instant, in ms (east of UTC is positive). */
function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in the zone. Two passes settle the offset across a DST
 * change; a time skipped by spring-forward lands an hour off, which hourly scheduling tolerates.
 */
export function zonedToUtc(local: ZonedDateTime, timeZone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = offsetMs(guess, timeZone);
  const second = offsetMs(guess - first, timeZone);
  return new Date(guess - second);
}

const addCalendarDays = (
  date: Pick<ZonedDateTime, 'year' | 'month' | 'day'>,
  days: number,
): Pick<ZonedDateTime, 'year' | 'month' | 'day'> => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

/**
 * The latest hour:00 in the zone at or before `slot`. A retry slot (failure + 1h) can cross
 * local midnight; anchoring keeps the next slot on the original calendar day, so it never drifts.
 */
export function anchorToHour(slot: Date, hour: number, timeZone: string): Date {
  const parts = zonedParts(slot, timeZone);
  const day = parts.hour >= hour ? parts : addCalendarDays(parts, -1);
  return zonedToUtc({ ...day, hour, minute: 0 }, timeZone);
}

/** The first hour:00 in the zone at or after `instant`. */
export function firstHourAtOrAfter(instant: Date, hour: number, timeZone: string): Date {
  const parts = zonedParts(instant, timeZone);
  const sameDay = zonedToUtc({ ...parts, hour, minute: 0 }, timeZone);
  return sameDay.getTime() >= instant.getTime()
    ? sameDay
    : zonedToUtc({ ...addCalendarDays(parts, 1), hour, minute: 0 }, timeZone);
}

/**
 * The next scheduled build: base's calendar date in the zone + everyDays, at hour:00 there.
 * If that is not after now, the first hour:00 strictly after now.
 */
export function nextIssueAt(input: {
  base: Date;
  everyDays: number;
  hour: number;
  timeZone: string;
  now: Date;
}): Date {
  const { base, everyDays, hour, timeZone, now } = input;
  const at = (date: Pick<ZonedDateTime, 'year' | 'month' | 'day'>): Date =>
    zonedToUtc({ ...date, hour, minute: 0 }, timeZone);

  const planned = at(addCalendarDays(zonedParts(base, timeZone), everyDays));
  if (planned.getTime() > now.getTime()) return planned;

  const today = zonedParts(now, timeZone);
  const sameDay = at(today);
  return sameDay.getTime() > now.getTime() ? sameDay : at(addCalendarDays(today, 1));
}
