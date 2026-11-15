import { describe, expect, it } from 'vitest';

import { slotAfterSlot } from './service';
import {
  anchorToHour,
  DEFAULT_TZ,
  isValidTimeZone,
  nextIssueAt,
  zonedParts,
  zonedToUtc,
} from './time';

const iso = (date: Date) => date.toISOString();

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects anything else', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone(DEFAULT_TZ)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Europe/' + 'x'.repeat(60))).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe('zonedToUtc', () => {
  it('converts wall-clock time on both sides of a DST change', () => {
    expect(
      iso(zonedToUtc({ year: 2026, month: 10, day: 24, hour: 8, minute: 0 }, 'Europe/Berlin')),
    ).toBe('2026-10-24T06:00:00.000Z');
    expect(
      iso(zonedToUtc({ year: 2026, month: 10, day: 25, hour: 8, minute: 0 }, 'Europe/Berlin')),
    ).toBe('2026-10-25T07:00:00.000Z');
    expect(zonedParts(new Date('2026-10-25T07:00:00Z'), 'Europe/Berlin').hour).toBe(8);
  });
});

describe('nextIssueAt', () => {
  const msk = 'Europe/Moscow';

  it('daily in MSK: the next day at the hour', () => {
    // 10:16 MSK on 15 November.
    const now = new Date('2026-11-15T07:16:00Z');
    const base = new Date('2026-11-15T05:00:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 8, timeZone: msk, now }))).toBe(
      '2026-11-16T05:00:00.000Z',
    );
  });

  it('weekly in MSK: seven calendar days after the base date', () => {
    const now = new Date('2026-11-15T07:16:00Z');
    const base = new Date('2026-11-15T07:00:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 7, hour: 8, timeZone: msk, now }))).toBe(
      '2026-11-22T05:00:00.000Z',
    );
  });

  it('uses the base date in the zone, not in UTC', () => {
    // 23:30 UTC on the 14th is already the 15th in Moscow.
    const base = new Date('2026-11-14T23:30:00Z');
    const now = new Date('2026-11-15T00:00:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 8, timeZone: msk, now }))).toBe(
      '2026-11-16T05:00:00.000Z',
    );
  });

  it('a base 10 days old falls back to the next hour:00 after now', () => {
    const base = new Date('2026-11-05T05:00:00Z');
    const beforeHour = new Date('2026-11-15T03:00:00Z'); // 06:00 MSK
    expect(iso(nextIssueAt({ base, everyDays: 3, hour: 8, timeZone: msk, now: beforeHour }))).toBe(
      '2026-11-15T05:00:00.000Z',
    );
    const afterHour = new Date('2026-11-15T07:16:00Z'); // 10:16 MSK
    expect(iso(nextIssueAt({ base, everyDays: 3, hour: 8, timeZone: msk, now: afterHour }))).toBe(
      '2026-11-16T05:00:00.000Z',
    );
    const exactly = new Date('2026-11-15T05:00:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 8, timeZone: msk, now: exactly }))).toBe(
      '2026-11-16T05:00:00.000Z',
    );
  });

  it('Europe/Berlin across the 2026-10-25 DST change keeps the local hour', () => {
    const base = new Date('2026-10-24T06:00:00Z'); // 08:00 CEST
    const now = new Date('2026-10-24T06:07:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 8, timeZone: 'Europe/Berlin', now }))).toBe(
      '2026-10-25T07:00:00.000Z', // 08:00 CET
    );
  });

  it('Asia/Kolkata (half-hour offset)', () => {
    const base = new Date('2026-11-15T02:30:00Z'); // 08:00 IST
    const now = new Date('2026-11-15T03:00:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 8, timeZone: 'Asia/Kolkata', now }))).toBe(
      '2026-11-16T02:30:00.000Z',
    );
  });

  it('hours 0 and 23', () => {
    const base = new Date('2026-11-15T07:00:00Z');
    const now = new Date('2026-11-15T07:16:00Z');
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 0, timeZone: msk, now }))).toBe(
      '2026-11-15T21:00:00.000Z',
    );
    expect(iso(nextIssueAt({ base, everyDays: 1, hour: 23, timeZone: msk, now }))).toBe(
      '2026-11-16T20:00:00.000Z',
    );
  });

  it('throws on an invalid zone', () => {
    const now = new Date();
    expect(() =>
      nextIssueAt({ base: now, everyDays: 1, hour: 8, timeZone: 'Mars/Olympus', now }),
    ).toThrow(RangeError);
  });
});

describe('anchorToHour / slotAfterSlot', () => {
  const omsk = 'Asia/Omsk'; // UTC+6, no DST

  it('keeps a retry slot that crossed local midnight on its scheduled day', () => {
    // Slot Mon 23:00 Omsk failed, retry at Tue 00:30 Omsk.
    const retry = new Date('2026-11-16T18:30:00Z');
    expect(anchorToHour(retry, 23, omsk).toISOString()).toBe('2026-11-16T17:00:00.000Z');
    const next = slotAfterSlot(
      { everyDays: 7, hour: 23, timeZone: omsk },
      retry,
      new Date('2026-11-16T18:31:00Z'),
    );
    // Next Monday 23:00 Omsk, not Tuesday.
    expect(next.toISOString()).toBe('2026-11-23T17:00:00.000Z');
  });

  it('leaves an on-time slot as it is', () => {
    const slot = new Date('2026-11-16T02:00:00Z'); // Mon 08:00 Omsk
    expect(anchorToHour(slot, 8, omsk).toISOString()).toBe(slot.toISOString());
    const retry = new Date('2026-11-16T03:00:00Z'); // 09:00, same day
    expect(anchorToHour(retry, 8, omsk).toISOString()).toBe(slot.toISOString());
  });
});
