import { describe, expect, it } from 'vitest';

import { daysTouched, formatDateline, issueWindow, mskDay, mskDayRange, mskTime } from './day';

describe('MSK days', () => {
  it('switches day at 21:00 UTC', () => {
    expect(mskDay(new Date('2026-11-14T20:59:59Z'))).toBe('2026-11-14');
    expect(mskDay(new Date('2026-11-14T21:00:00Z'))).toBe('2026-11-15');
  });

  it('day range is a half-open 24h window', () => {
    const { start, end } = mskDayRange('2026-11-15');
    expect(start.toISOString()).toBe('2026-11-14T21:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
    expect(mskDay(start)).toBe('2026-11-15');
    expect(mskDay(end)).toBe('2026-11-16');
  });

  it('daysTouched lists every MSK day of the window, oldest first', () => {
    expect(daysTouched(new Date('2026-10-30T21:00:00Z'), new Date('2026-11-01T10:00:00Z'))).toEqual(
      ['2026-10-31', '2026-11-01'],
    );
    expect(daysTouched(new Date('2026-10-30T20:59:59Z'), new Date('2026-10-30T21:00:00Z'))).toEqual(
      ['2026-10-30', '2026-10-31'],
    );
    expect(() => daysTouched(new Date(2), new Date(1))).toThrow();
  });
});

describe('issueWindow', () => {
  // 10:16 MSK on 15 November.
  const now = new Date('2026-11-15T07:16:00Z');
  const hour = 3_600_000;
  const ago = (hours: number) => new Date(now.getTime() - hours * hour);

  it('without a previous issue covers the last maxDays×24h', () => {
    const period = issueWindow({ maxDays: 1, now });
    expect(period.start.toISOString()).toBe('2026-11-14T07:16:00.000Z');
    expect(period.end).toBe(now);
    expect(period.days).toEqual(['2026-11-14', '2026-11-15']);
    expect(formatDateline(period.days)).toBe('14–15 ноября 2026');

    const weekly = issueWindow({ maxDays: 7, now });
    expect(weekly.start.toISOString()).toBe('2026-11-08T07:16:00.000Z');
    expect(() => issueWindow({ maxDays: 0, now })).toThrow();
  });

  it('starts at the previous ready issue end inside the cap', () => {
    const previousEnd = new Date('2026-11-14T18:00:00Z');
    const period = issueWindow({ maxDays: 1, now, previousEnd });
    expect(period.start).toEqual(previousEnd);
    expect(period.days).toEqual(['2026-11-14', '2026-11-15']);

    const sameDay = issueWindow({ maxDays: 1, now, previousEnd: new Date('2026-11-15T03:00:00Z') });
    expect(sameDay.days).toEqual(['2026-11-15']);
    expect(formatDateline(sameDay.days)).toBe('15 ноября 2026');

    const weekly = issueWindow({ maxDays: 7, now, previousEnd: ago(100) });
    expect(weekly.start).toEqual(ago(100));
  });

  it('continues across the 3h grace past the cap, not beyond it', () => {
    expect(issueWindow({ maxDays: 1, now, previousEnd: ago(26) }).start).toEqual(ago(26));
    expect(issueWindow({ maxDays: 1, now, previousEnd: ago(27) }).start).toEqual(ago(24));
    expect(issueWindow({ maxDays: 3, now, previousEnd: ago(74.5) }).start).toEqual(ago(74.5));
  });

  it('ignores a previous issue beyond the cap or in the future', () => {
    // The daily carryover used to reach back 7 days; now it is 24h + grace.
    const old = issueWindow({ maxDays: 1, now, previousEnd: new Date('2026-11-12T00:00:00Z') });
    expect(old.start.toISOString()).toBe('2026-11-14T07:16:00.000Z');
    const future = issueWindow({ maxDays: 1, now, previousEnd: new Date('2026-11-16T00:00:00Z') });
    expect(future.start.toISOString()).toBe('2026-11-14T07:16:00.000Z');
    const equal = issueWindow({ maxDays: 1, now, previousEnd: now });
    expect(equal.start.toISOString()).toBe('2026-11-14T07:16:00.000Z');
  });

  it('formats MSK time', () => {
    expect(mskTime(new Date('2026-11-14T21:05:00Z'))).toBe('00:05');
  });
});

describe('formatDateline', () => {
  it('formats one day', () => {
    expect(formatDateline(['2026-11-14'])).toBe('14 ноября 2026');
  });

  it('formats a range within a month', () => {
    expect(formatDateline(['2026-11-12', '2026-11-13', '2026-11-14'])).toBe('12–14 ноября 2026');
  });

  it('formats ranges across months and years', () => {
    expect(formatDateline(['2026-10-30', '2026-11-01'])).toBe('30 октября – 1 ноября 2026');
    expect(formatDateline(['2026-12-31', '2027-01-01'])).toBe('31 декабря 2026 – 1 января 2027');
  });
});
