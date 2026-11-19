/** SQL-level checks of the app store: quota filters, the global-cap lock and PDF send counting. */
import { describe, expect, it } from 'vitest';

import { recordingDb } from '@/db/__fixtures__/recording-db';

import { FREE_FAILURE_CODES, QUOTA_EXEMPT_CODES } from './contract';
import { createAppDbStore } from './store';

const ID = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e';
const MANUAL = `"issues"."trigger" = 'manual'`;
const EXEMPT = `split_part(coalesce("issues"."error", ''), ':', 1) in (`;

const claimQueries = async () => {
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
    trigger: 'manual',
    since: now,
    staleBefore: now,
    perUserLimit: 3,
    globalLimit: 30,
  });
  return queries;
};

describe('quota SQL is built from the shared exempt lists', () => {
  it('countBuilds: manual only, every QUOTA_EXEMPT_CODES code (timeout included)', async () => {
    const { db, queries } = recordingDb(() => [[0]]);
    await createAppDbStore(db).countBuilds(1, new Date());
    const [query] = queries;
    expect(query?.text).toContain(MANUAL);
    expect(query?.text).toContain(EXEMPT);
    expect(QUOTA_EXEMPT_CODES).toContain('timeout');
    expect(query?.params).toEqual(expect.arrayContaining([...QUOTA_EXEMPT_CODES]));
  });

  it('a claim: per-user count exempts timeout, the global count does not', async () => {
    const queries = await claimQueries();
    const counts = queries.filter((q) => q.text.includes('count(') && q.text.includes('"issues"'));
    const perUser = counts.find((q) => q.text.includes('"issues"."user_id" = $'));
    const global = counts.find((q) => !q.text.includes('"user_id"'));
    expect(perUser?.text).toContain(MANUAL);
    expect(perUser?.params).toEqual(expect.arrayContaining([...QUOTA_EXEMPT_CODES]));
    expect(global?.text).toContain(EXEMPT);
    expect(global?.params).toEqual(expect.arrayContaining([...FREE_FAILURE_CODES]));
    expect(global?.params).not.toContain('timeout');
  });

  it('a claim takes the global advisory lock after the user row lock, before the global count', async () => {
    const texts = (await claimQueries()).map((q) => q.text);
    const userLock = texts.findIndex((t) => t.includes('from "users"') && t.includes('for update'));
    const lock = texts.findIndex((t) => t.includes('pg_advisory_xact_lock('));
    const global = texts.findIndex(
      (t) => t.includes('count(') && t.includes('"issues"') && !t.includes('"user_id"'),
    );
    expect(userLock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(userLock);
    expect(global).toBeGreaterThan(lock);
  });
});

describe('PDF sends', () => {
  it('claimPdfSend is one conditional UPDATE that resets on a new day', async () => {
    const { db, queries } = recordingDb(() => [[1]]);
    expect(await createAppDbStore(db).claimPdfSend(1, '2026-11-15', 5)).toBe(true);
    expect(queries).toHaveLength(1);
    const text = queries[0]?.text ?? '';
    expect(text).toMatch(/^update "users" set "pdf_sends_day" = \$\d+, "pdf_sends_count" = case/);
    expect(text).toContain('"users"."pdf_sends_day" is distinct from');
    expect(text).toContain('"users"."pdf_sends_count" < $');
    expect(text).toContain('returning');
    expect(queries[0]?.params).toEqual(expect.arrayContaining(['2026-11-15', 5, 1]));
  });

  it('claimPdfSend is false when no row was updated (limit reached)', async () => {
    const { db } = recordingDb(() => []);
    expect(await createAppDbStore(db).claimPdfSend(1, '2026-11-15', 5)).toBe(false);
  });

  it('refundPdfSend only decrements the same day, never below zero', async () => {
    const { db, queries } = recordingDb();
    await createAppDbStore(db).refundPdfSend(1, '2026-11-15');
    const text = queries[0]?.text ?? '';
    expect(text).toContain('greatest("users"."pdf_sends_count" - 1, 0)');
    expect(text).toContain('"users"."pdf_sends_day" = $');
  });

  it('getReadyIssue returns the cached file only with its bot', async () => {
    const created = new Date();
    const withFile = recordingDb(() => [[ID, 3, created, null, 'file-1', 'dev']]);
    expect((await createAppDbStore(withFile.db).getReadyIssue(1, ID))?.pdfFile).toEqual({
      fileId: 'file-1',
      bot: 'dev',
    });
    const without = recordingDb(() => [[ID, 3, created, null, null, null]]);
    expect((await createAppDbStore(without.db).getReadyIssue(1, ID))?.pdfFile).toBeNull();
  });
});

describe('channel lookups', () => {
  const claimLookups = async (row: unknown[] | null, count: number, limit = 300) => {
    const { db, queries } = recordingDb((text) =>
      text.startsWith('select') ? (row === null ? [] : [row]) : [],
    );
    const granted = await createAppDbStore(db).claimChannelLookups(1, '2026-11-20', count, limit);
    const update = queries.find((q) => q.text.startsWith('update'));
    return { granted, queries, update };
  };

  it('claimChannelLookups locks the user row, then adds what it grants', async () => {
    const { granted, queries, update } = await claimLookups(['2026-11-20', 10], 4);
    expect(granted).toBe(4);
    const select = queries.find((q) => q.text.startsWith('select'));
    expect(select?.text).toContain('for update');
    expect(queries.indexOf(select!)).toBeLessThan(queries.indexOf(update!));
    expect(update?.text).toMatch(
      /^update "users" set "channel_lookups_day" = \$\d+, "channel_lookups_count" = \$\d+/,
    );
    expect(update?.params).toEqual(['2026-11-20', 14, 1]);
  });

  it('claimChannelLookups grants only what is left of the limit', async () => {
    const { granted, update } = await claimLookups(['2026-11-20', 297], 10);
    expect(granted).toBe(3);
    expect(update?.params).toEqual(['2026-11-20', 300, 1]);
  });

  it('claimChannelLookups resets the counter on a new day', async () => {
    const { granted, update } = await claimLookups(['2026-11-19', 300], 4);
    expect(granted).toBe(4);
    expect(update?.params).toEqual(['2026-11-20', 4, 1]);
  });

  it.each([
    ['the limit is reached', ['2026-11-20', 300] as unknown[] | null],
    ['the user row is missing', null],
  ])('claimChannelLookups grants 0 and writes nothing when %s', async (_label, row) => {
    const { granted, update } = await claimLookups(row, 4);
    expect(granted).toBe(0);
    expect(update).toBeUndefined();
  });

  it('refundChannelLookups decrements the same day only, never below zero, and skips 0', async () => {
    const { db, queries } = recordingDb();
    const store = createAppDbStore(db);
    await store.refundChannelLookups(1, '2026-11-20', 0);
    expect(queries).toHaveLength(0);
    await store.refundChannelLookups(1, '2026-11-20', 3);
    const text = queries[0]?.text ?? '';
    expect(text).toContain('greatest("users"."channel_lookups_count" - $');
    expect(text).toContain('"users"."channel_lookups_day" = $');
  });
});
