/**
 * issues.deleted_at semantics at the SQL level: read paths hide soft-deleted issues, counting
 * paths (numbering, quota, claims) keep them.
 */
import { describe, expect, it } from 'vitest';

import { createBotDbStore } from '@/bot/store';
import { createAppDbStore } from '@/miniapp/store';
import { createIssueDbStore } from '@/pipeline/store';
import { createScheduleDbStore } from '@/schedule/store';

import { recordingDb } from './__fixtures__/recording-db';

const ID = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e';
const DELETED_FILTER = '"issues"."deleted_at" is null';

const only = (queries: { text: string }[]): string => {
  expect(queries).toHaveLength(1);
  return queries[0]?.text ?? '';
};

describe('read paths filter soft-deleted issues', () => {
  it('archive, latest issue and getIssue', async () => {
    const list = recordingDb();
    await createAppDbStore(list.db).listReadyIssues(1, { limit: 1 });
    expect(only(list.queries)).toContain(DELETED_FILTER);

    const get = recordingDb();
    await createAppDbStore(get.db).getIssue(1, ID);
    expect(only(get.queries)).toContain(DELETED_FILTER);

    const ready = recordingDb();
    await createAppDbStore(ready.db).getReadyIssue(1, ID);
    expect(only(ready.queries)).toContain(DELETED_FILTER);
  });

  it('claimNotify never claims a deleted issue', async () => {
    const { db, queries } = recordingDb();
    expect(await createBotDbStore(db).claimNotify(ID)).toBe(false);
    const text = only(queries);
    expect(text).toMatch(/^update "issues"/);
    expect(text).toContain(DELETED_FILTER);
  });

  it('lastReadyPeriodEnd skips deleted issues (owner decision)', async () => {
    const { db, queries } = recordingDb();
    await createIssueDbStore(db).lastReadyPeriodEnd(1);
    expect(only(queries)).toContain(DELETED_FILTER);
  });
});

describe('counting paths keep soft-deleted issues', () => {
  it('numbering takes max(number) over every issue of the user', async () => {
    const { db, queries } = recordingDb((text) => {
      if (text.startsWith('select "user_id", "status"')) return [[1, 'composing']];
      if (text.includes('max(')) return [[7]];
      if (text.startsWith('update "issues"')) return [[ID]];
      return [];
    });
    const number = await createIssueDbStore(db).complete(ID, () => ({ content: {}, stats: {} }));
    expect(number).toBe(8);
    const max = queries.find((query) => query.text.includes('max('));
    expect(max?.text).not.toContain('deleted_at');
  });

  it('quota counts do not look at deleted_at', async () => {
    const { db, queries } = recordingDb(() => [[0]]);
    await createAppDbStore(db).countBuilds(1, new Date());
    expect(only(queries)).not.toContain('deleted_at');
  });

  it('a claim counts deleted issues toward the user and global caps', async () => {
    const { db, queries } = recordingDb((text) => {
      if (text.includes('from "users"')) return [[1]];
      if (text.includes('count(')) return [[0]];
      return [];
    });
    const now = new Date();
    await createAppDbStore(db).claimIssue({
      userId: 1,
      period: { start: now, end: now },
      trigger: 'manual',
      since: now,
      staleBefore: now,
      perUserLimit: 3,
      globalLimit: 30,
    });
    const claimSql = queries.map((query) => query.text).join('\n');
    expect(claimSql).toContain('count(');
    expect(claimSql).not.toContain('deleted_at');
  });
});

describe('softDeleteIssue', () => {
  it('updates only the user own ready issue and keeps the first deletion time', async () => {
    const { db, queries } = recordingDb((text) => (text.startsWith('update') ? [[ID]] : []));
    expect(await createAppDbStore(db).softDeleteIssue(1, ID)).toBe('deleted');
    const text = only(queries);
    expect(text).toContain('"deleted_at" = coalesce("issues"."deleted_at", now())');
    expect(text).toContain('"issues"."user_id" = $');
    expect(text).toContain('"issues"."status" = $');
    expect(queries[0]?.params).toEqual(expect.arrayContaining([ID, 1, 'ready']));
  });

  it('busy for an in-flight issue, not_found otherwise', async () => {
    const busy = recordingDb((text) => (text.startsWith('select') ? [[ID]] : []));
    expect(await createAppDbStore(busy.db).softDeleteIssue(1, ID)).toBe('busy');
    expect(busy.queries[1]?.params).toEqual(expect.arrayContaining(['pending', 'composing']));

    const missing = recordingDb();
    expect(await createAppDbStore(missing.db).softDeleteIssue(1, ID)).toBe('not_found');
  });
});

describe('only manual builds use up the per-user quota', () => {
  const MANUAL = `"issues"."trigger" = 'manual'`;

  it('countBuilds counts manual builds only', async () => {
    const { db, queries } = recordingDb(() => [[0]]);
    await createAppDbStore(db).countBuilds(1, new Date());
    expect(only(queries)).toContain(MANUAL);
  });

  it('a claim counts manual builds per user, both triggers globally, and stores the trigger', async () => {
    const { db, queries } = recordingDb((text) => {
      if (text.includes('from "users"')) return [[1]];
      if (text.includes('from "user_channels"')) return [[1]];
      if (text.includes('count(')) return [[0]];
      if (text.startsWith('insert')) return [[ID, 'pending', null, null, 0, 0, new Date(), null]];
      return [];
    });
    const now = new Date();
    await createAppDbStore(db).claimIssue({
      userId: 1,
      period: { start: now, end: now },
      trigger: 'scheduled',
      since: now,
      staleBefore: now,
      perUserLimit: 3,
      globalLimit: 30,
    });
    const counts = queries.filter(
      (query) => query.text.includes('count(') && query.text.includes('from "issues"'),
    );
    const perUser = counts.filter((query) => query.text.includes('"issues"."user_id" = $'));
    const global = counts.filter(
      (query) => query.text.includes('from "issues"') && !query.text.includes('"user_id"'),
    );
    expect(perUser).toHaveLength(1);
    expect(perUser[0]?.text).toContain(MANUAL);
    expect(global).toHaveLength(1);
    expect(global[0]?.text).not.toContain('trigger');
    const insert = queries.find((query) => query.text.startsWith('insert into "issues"'));
    expect(insert?.params).toContain('scheduled');
  });
});

describe('opened tracking', () => {
  it('markOpened sets opened_at once on the own ready, non-deleted issue', async () => {
    const { db, queries } = recordingDb();
    await createAppDbStore(db).markOpened(1, ID);
    const text = only(queries);
    expect(text).toMatch(/^update "issues" set "opened_at" = coalesce/);
    expect(text).toContain('"issues"."user_id" = $');
    expect(text).toContain(DELETED_FILTER);
    expect(queries[0]?.params).toEqual(expect.arrayContaining([ID, 1, 'ready']));
  });
});

describe('schedule resume', () => {
  it('enabling acknowledges unread auto issues, so the unread pause does not re-fire', async () => {
    const { db, queries } = recordingDb();
    await createScheduleDbStore(db).update(1, {
      enabled: true,
      everyDays: 1,
      hour: 8,
      timeZone: 'Europe/Moscow',
      nextIssueAt: null,
      clearPause: true,
    });
    const ack = queries.find((q) => q.text.startsWith('update "issues"'))?.text ?? '';
    expect(ack).toContain('"opened_at" = coalesce(');
    expect(ack).toMatch(/"issues"\."trigger" = \$\d/);
    expect(ack).toContain('"issues"."opened_at" is null');
  });

  it('a save that does not resume leaves issues alone', async () => {
    const { db, queries } = recordingDb();
    await createScheduleDbStore(db).update(1, {
      enabled: false,
      everyDays: 1,
      hour: 8,
      timeZone: 'Europe/Moscow',
      nextIssueAt: null,
      clearPause: false,
    });
    expect(queries.some((q) => q.text.startsWith('update "issues"'))).toBe(false);
  });
});
