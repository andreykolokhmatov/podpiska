/**
 * issues.deleted_at semantics at the SQL level: read paths hide soft-deleted issues, counting
 * paths (numbering, quota, claims) keep them.
 */
import { describe, expect, it } from 'vitest';

import { createBotDbStore } from '@/bot/store';
import { createAppDbStore } from '@/miniapp/store';
import { createIssueDbStore } from '@/pipeline/store';

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
