/** SQL-level checks of the channel upsert during collect: the best-effort tg_id step. */
import { describe, expect, it, vi } from 'vitest';

import { recordingDb } from '@/db/__fixtures__/recording-db';

import { saveChannelPosts } from './store';
import type { ChannelInfo } from './types';

const info = (tgId: number | null): ChannelInfo => ({
  username: 'toporlive',
  displayUsername: 'toporlive',
  title: 'Топор Live',
  avatarUrl: null,
  tgId,
});

const pgError = (code: string) => Object.assign(new Error('pg'), { code });

const db = (failSetTgId?: Error) =>
  recordingDb((text) => {
    if (text.startsWith('insert into "channels"')) return [[5]];
    if (
      failSetTgId &&
      text.startsWith('update "channels" set "tg_id" = $1 where "channels"."username"')
    )
      throw failSetTgId;
    return [];
  });

const shape = (text: string) => text.split(' where')[0];

describe('saveChannelPosts tg_id', () => {
  it('upserts without tg_id, then releases and sets it in a savepoint of the same tx', async () => {
    const { db: database, queries } = db();
    await saveChannelPosts(database, info(1754252633), []);
    expect(queries.map((q) => shape(q.text))).toEqual([
      'begin',
      expect.stringMatching(/^insert into "channels"/),
      'savepoint sp1',
      'update "channels" set "tg_id" = $1',
      'update "channels" set "tg_id" = $1',
      'release savepoint sp1',
      'commit',
    ]);
    expect(queries[1]?.text.split('do update set')[1]).not.toContain('tg_id');
    expect(queries[3]?.text).toContain('"channels"."username" <> $3');
    expect(queries[3]?.params).toEqual([null, 1754252633, 'toporlive']);
    expect(queries[4]?.params).toEqual([1754252633, 'toporlive']);
  });

  it('skips the tg_id step when the page did not reveal one', async () => {
    const { db: database, queries } = db();
    await saveChannelPosts(database, info(null), []);
    expect(queries.some((q) => q.text.startsWith('update') || q.text.includes('savepoint'))).toBe(
      false,
    );
  });

  it('a unique violation rolls back only the savepoint; the collect still commits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db: database, queries } = db(pgError('23505'));
    await expect(saveChannelPosts(database, info(1754252633), [])).resolves.toEqual({
      collected: 0,
      inserted: 0,
    });
    const texts = queries.map((q) => q.text);
    expect(texts).toContain('rollback to savepoint sp1');
    expect(texts.at(-1)).toBe('commit');
    expect(warn).toHaveBeenCalledWith('tg_id not recorded for @toporlive: unique conflict');
    warn.mockRestore();
  });

  it('rethrows any other error from the tg_id step', async () => {
    const { db: database, queries } = db(pgError('57014'));
    await expect(saveChannelPosts(database, info(1754252633), [])).rejects.toThrow();
    expect(queries.at(-1)?.text).toBe('rollback');
  });
});
