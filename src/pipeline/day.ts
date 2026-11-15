// Moscow has had a fixed UTC+3 offset (no DST) since 2014.
const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** Calendar day in Europe/Moscow as YYYY-MM-DD. */
export function mskDay(date: Date): string {
  return new Date(date.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Half-open [start, end) UTC range of an MSK day. */
export function mskDayRange(day: string): { start: Date; end: Date } {
  const start = Date.parse(`${day}T00:00:00.000Z`) - MSK_OFFSET_MS;
  if (Number.isNaN(start)) {
    throw new Error(`invalid day: ${day}`);
  }
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

export function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

export interface Period {
  start: Date;
  end: Date;
  /** Every MSK day the window touches, oldest first. */
  days: string[];
}

/** MSK days touched by the window [start, end], oldest first. */
export function daysTouched(start: Date, end: Date): string[] {
  if (end.getTime() < start.getTime()) {
    throw new Error('window ends before it starts');
  }
  const days: string[] = [];
  const last = mskDay(end);
  for (let day = mskDay(start); day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/** A previous issue may end up to this much earlier than the cap and still be continued. */
export const CARRYOVER_GRACE_MS = 3 * 3_600_000;

/**
 * The issue window (start, end = now]: continues from the previous ready issue's end when that
 * lies within maxDays×24h + 3h grace, otherwise covers the last maxDays×24h.
 */
export function issueWindow(input: {
  maxDays: number;
  now: Date;
  previousEnd?: Date | undefined;
}): Period {
  const { maxDays, now, previousEnd } = input;
  if (!Number.isInteger(maxDays) || maxDays < 1) {
    throw new Error(`maxDays must be a positive integer, got ${maxDays}`);
  }
  const nowMs = now.getTime();
  let startMs = nowMs - maxDays * DAY_MS;
  if (previousEnd !== undefined) {
    const prevMs = previousEnd.getTime();
    if (prevMs < nowMs && prevMs > startMs - CARRYOVER_GRACE_MS) startMs = prevMs;
  }
  const start = new Date(startMs);
  return { start, end: now, days: daysTouched(start, now) };
}

/** HH:MM in Moscow time. */
export function mskTime(date: Date): string {
  return new Date(date.getTime() + MSK_OFFSET_MS).toISOString().slice(11, 16);
}

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const parts = (day: string): { d: number; m: string; y: number } => {
  const [y, m, d] = day.split('-').map(Number);
  const month = m === undefined ? undefined : MONTHS[m - 1];
  if (y === undefined || d === undefined || month === undefined) {
    throw new Error(`invalid day: ${day}`);
  }
  return { d, m: month, y };
};

/** «14 ноября 2026», «12–14 ноября 2026», «30 октября – 1 ноября 2026». */
export function formatDateline(days: readonly string[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('empty period');
  }
  const a = parts(first);
  const b = parts(last);
  if (first === last) return `${a.d} ${a.m} ${a.y}`;
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`;
  return `${a.d}–${b.d} ${b.m} ${b.y}`;
}
