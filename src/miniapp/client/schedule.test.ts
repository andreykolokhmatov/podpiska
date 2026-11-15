import { describe, expect, it } from 'vitest';

import type { ScheduleView } from '@/miniapp/contract';

import {
  draftFrom,
  hourLabel,
  hourOption,
  nextIssueLine,
  sameDraft,
  scheduleNote,
  timeZoneName,
  whenLabel,
} from './schedule';
import { t } from './texts';

// Sunday 15 Nov 2026, 12:00 Moscow.
const NOW = new Date('2026-11-15T09:00:00Z');

const active: ScheduleView = {
  enabled: true,
  everyDays: 7,
  hour: 8,
  timeZone: 'Europe/Moscow',
  nextIssueAt: '2026-11-16T05:00:00.000Z',
  paused: false,
  active: true,
  canNotify: true,
};

describe('whenLabel', () => {
  it('says today / tomorrow / weekday in the schedule zone', () => {
    expect(whenLabel(new Date('2026-11-15T15:00:00Z'), 'Europe/Moscow', NOW)).toBe(
      'сегодня, 18:00',
    );
    expect(whenLabel(new Date('2026-11-16T05:00:00Z'), 'Europe/Moscow', NOW)).toBe('завтра, 8:00');
    expect(whenLabel(new Date('2026-11-17T05:00:00Z'), 'Europe/Moscow', NOW)).toBe('вт, 8:00');
  });

  it('uses the zone for both the day and the hour', () => {
    // 20:00 UTC Sunday is 02:00 Monday in Omsk (UTC+6).
    expect(whenLabel(new Date('2026-11-15T20:00:00Z'), 'Asia/Omsk', NOW)).toBe('завтра, 2:00');
    expect(whenLabel(new Date('2026-11-15T21:00:00Z'), 'Europe/Moscow', NOW)).toBe('завтра, 0:00');
  });
});

describe('nextIssueLine', () => {
  it('shows the next issue with the frequency', () => {
    expect(nextIssueLine(active, NOW)).toBe('завтра, 8:00 · раз в неделю');
    expect(
      nextIssueLine({ ...active, everyDays: 3, nextIssueAt: '2026-11-18T05:00:00.000Z' }, NOW),
    ).toBe('ср, 8:00 · раз в 3 дня');
  });

  it('explains every inactive state', () => {
    expect(nextIssueLine({ ...active, enabled: false, nextIssueAt: null }, NOW)).toBe('Выключено');
    expect(nextIssueLine({ ...active, paused: true, nextIssueAt: null }, NOW)).toBe(
      'Приостановлено – включите снова',
    );
    expect(nextIssueLine({ ...active, nextIssueAt: null, active: false }, NOW)).toBe(
      'Начнётся после первого выпуска',
    );
    expect(nextIssueLine({ ...active, canNotify: false, nextIssueAt: null }, NOW)).toBe(
      'Нужно разрешение на сообщения',
    );
    // Bot unreachable pauses and drops canNotify: permission is the fix, not reading.
    expect(
      nextIssueLine({ ...active, canNotify: false, paused: true, nextIssueAt: null }, NOW),
    ).toBe('Нужно разрешение на сообщения');
  });

  it('never uses the em dash', () => {
    const views: ScheduleView[] = [
      active,
      { ...active, enabled: false },
      { ...active, paused: true },
      { ...active, nextIssueAt: null },
      { ...active, canNotify: false },
    ];
    for (const view of views) {
      expect(nextIssueLine(view, NOW)).not.toContain('—');
      expect(scheduleNote(view, NOW)).not.toContain('—');
    }
  });
});

describe('scheduleNote', () => {
  it('matches the saved state', () => {
    expect(scheduleNote(active, NOW)).toBe('Следующий выпуск – завтра, 8:00.');
    expect(scheduleNote({ ...active, paused: true }, NOW)).toBe(t.schedule.pausedNote);
    expect(scheduleNote({ ...active, nextIssueAt: null }, NOW)).toBe(t.schedule.firstIssueNote);
    expect(scheduleNote({ ...active, canNotify: false }, NOW)).toBe(t.schedule.permissionNote);
    expect(scheduleNote({ ...active, enabled: false }, NOW)).toBe(t.schedule.offNote);
  });
});

describe('draft', () => {
  it('shows the switch off when paused or without permission', () => {
    expect(draftFrom(active)).toEqual({ enabled: true, everyDays: 7, hour: 8 });
    expect(draftFrom({ ...active, paused: true }).enabled).toBe(false);
    expect(draftFrom({ ...active, canNotify: false }).enabled).toBe(false);
  });

  it('compares drafts by value', () => {
    const a = draftFrom(active);
    expect(sameDraft(a, { ...a })).toBe(true);
    expect(sameDraft(a, { ...a, hour: 9 })).toBe(false);
    expect(sameDraft(a, { ...a, everyDays: 1 })).toBe(false);
    expect(sameDraft(a, { ...a, enabled: false })).toBe(false);
  });
});

describe('formatting', () => {
  it('formats hours', () => {
    expect(hourOption(0)).toBe('00:00');
    expect(hourOption(23)).toBe('23:00');
    expect(hourLabel(8)).toBe('8:00');
  });

  it('names the time zone with its UTC offset', () => {
    expect(timeZoneName('Asia/Omsk', NOW)).toBe('Омск (UTC+6)');
    expect(timeZoneName('Europe/Moscow', NOW)).toBe('Москва (UTC+3)');
    expect(timeZoneName('Asia/Kolkata', NOW)).toBe('Индия (UTC+5:30)');
  });
});
