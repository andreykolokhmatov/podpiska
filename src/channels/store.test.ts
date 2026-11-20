/** SQL-level checks of the bulk link: one transaction, user row locked, limit applied in order. */
import { describe, expect, it, vi } from 'vitest';

import { recordingDb } from '@/db/__fixtures__/recording-db';

import { createChannelsDbStore, findChannelsByTgIds, setChannelTgId } from './store';

const bulkDb = (opts: { known: [number, string][]; linked: string[]; count: number }) =>
  recordingDb((text) => {
    if (text.includes('from "users"') && text.includes('for update')) return [[1]];
    if (text.includes('count(')) return [[opts.count]];
    if (text.startsWith('select "id", "username" from "channels"')) return opts.known;
    if (text.includes('from "user_channels"')) return opts.linked.map((name) => [name]);
    return [];
  });

describe('linkUserChannels', () => {
  it('links known channels in input order up to the limit, in one locked transaction', async () => {
    const { db, queries } = bulkDb({
      known: [
        [11, 'chan_one'],
        [12, 'chan_two'],
        [13, 'chan_three'],
        [14, 'chan_four'],
      ],
      linked: ['chan_two'],
      count: 3,
    });
    const results = await createChannelsDbStore(db).linkUserChannels(
      1,
      ['chan_one', 'chan_two', 'gone_chan', 'chan_three', 'chan_one', 'chan_four'],
      5,
    );
    expect(results).toEqual([
      { username: 'chan_one', status: 'added' },
      { username: 'chan_two', status: 'exists' },
      { username: 'gone_chan', status: 'not_found' },
      { username: 'chan_three', status: 'added' },
      { username: 'chan_four', status: 'limit' },
    ]);
    const texts = queries.map((q) => q.text);
    expect(texts[0]).toBe('begin');
    expect(texts[1]).toContain('for update');
    expect(texts.at(-1)).toBe('commit');
    const known = queries.find((q) => q.text.startsWith('select "id", "username" from "channels"'));
    expect(known?.text).toContain('"channels"."is_available" = $');
    const insert = queries.find((q) => q.text.startsWith('insert into "user_channels"'));
    expect(insert?.text).toContain('on conflict do nothing');
    expect(insert?.params).toEqual([1, 11, 1, 13]);
    expect(texts.some((t) => t.startsWith('insert into "channels"'))).toBe(false);
  });

  it('answers exists for a linked channel that is no longer available', async () => {
    const { db, queries } = bulkDb({ known: [], linked: ['gone_chan'], count: 1 });
    const results = await createChannelsDbStore(db).linkUserChannels(1, ['gone_chan'], 5);
    expect(results).toEqual([{ username: 'gone_chan', status: 'exists' }]);
    expect(queries.some((q) => q.text.startsWith('insert'))).toBe(false);
  });

  it('with no limit skips the count and links everything known', async () => {
    const { db, queries } = bulkDb({ known: [[11, 'chan_one']], linked: [], count: 999 });
    const results = await createChannelsDbStore(db).linkUserChannels(1, ['chan_one'], null);
    expect(results).toEqual([{ username: 'chan_one', status: 'added' }]);
    expect(queries.some((q) => q.text.includes('count('))).toBe(false);
  });

  it('writes nothing when every result is limit', async () => {
    const { db, queries } = bulkDb({ known: [[11, 'chan_one']], linked: [], count: 2 });
    const results = await createChannelsDbStore(db).linkUserChannels(1, ['chan_one'], 2);
    expect(results).toEqual([{ username: 'chan_one', status: 'limit' }]);
    expect(queries.some((q) => q.text.startsWith('insert'))).toBe(false);
  });

  it('does nothing for an empty list', async () => {
    const { db, queries } = recordingDb();
    expect(await createChannelsDbStore(db).linkUserChannels(1, [], 5)).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});

describe('linkUserChannel', () => {
  it('skips the count with no limit', async () => {
    const { db, queries } = recordingDb((text) => {
      if (text.includes('for update')) return [[1]];
      if (text.startsWith('insert into "channels"')) return [[11]];
      return [];
    });
    const status = await createChannelsDbStore(db).linkUserChannel(
      1,
      { username: 'chan_one', displayUsername: 'chan_one', title: null, avatarUrl: null },
      null,
    );
    expect(status).toBe('added');
    expect(queries.some((q) => q.text.includes('count('))).toBe(false);
  });
});

describe('cache lookups', () => {
  it('findAvailableChannels and listLinkedUsernames skip the query for an empty list', async () => {
    const { db, queries } = recordingDb();
    const store = createChannelsDbStore(db);
    expect(await store.findAvailableChannels([])).toEqual([]);
    expect(await store.listLinkedUsernames(1, [])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('findAvailableChannels reads only available channels', async () => {
    const { db, queries } = recordingDb(() => [['chan_one', 'T', null]]);
    expect(await createChannelsDbStore(db).findAvailableChannels(['chan_one'])).toEqual([
      { username: 'chan_one', displayUsername: 'chan_one', title: 'T', avatarUrl: null },
    ]);
    expect(queries[0]?.text).toContain('"channels"."is_available" = $');
  });
});

const channel = (tgId?: number | null) => ({
  username: 'toporlive',
  displayUsername: 'toporlive',
  title: 'Топор Live',
  avatarUrl: null,
  ...(tgId === undefined ? {} : { tgId }),
});

const shape = (text: string) => text.split(' where')[0];
const TG_STEP = [
  'savepoint sp1',
  'update "channels" set "tg_id" = $1',
  'update "channels" set "tg_id" = $1',
  'release savepoint sp1',
];

describe('channel tg_id', () => {
  const upsertDb = (failSetTgId?: Error) =>
    recordingDb((text) => {
      if (text.includes('for update')) return [[1]];
      if (text.includes('count(')) return [[0]];
      if (text.startsWith('insert into "channels"')) return [[5]];
      if (
        failSetTgId &&
        text.startsWith('update "channels" set "tg_id" = $1 where "channels"."username"')
      )
        throw failSetTgId;
      return [];
    });

  it('upsertChannel upserts without tg_id, then sets it in a savepoint, in one tx', async () => {
    const { db, queries } = upsertDb();
    await createChannelsDbStore(db).upsertChannel(channel(1754252633));
    expect(queries.map((q) => shape(q.text))).toEqual([
      'begin',
      expect.stringMatching(/^insert into "channels"/),
      ...TG_STEP,
      'commit',
    ]);
    expect(queries[1]?.text.split('do update set')[1]).not.toContain('tg_id');
    expect(queries[3]?.params).toEqual([null, 1754252633, 'toporlive']);
  });

  it('upsertChannel without a tg id leaves tg_id alone', async () => {
    const { db, queries } = upsertDb();
    await createChannelsDbStore(db).upsertChannel(channel());
    expect(queries.some((q) => q.text.startsWith('update') || q.text.includes('savepoint'))).toBe(
      false,
    );
  });

  it('linkUserChannel still links when the tg_id step hits a unique violation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, queries } = upsertDb(Object.assign(new Error('pg'), { code: '23505' }));
    expect(await createChannelsDbStore(db).linkUserChannel(1, channel(1754252633), 5)).toBe(
      'added',
    );
    const texts = queries.map((q) => q.text);
    const insertChannel = texts.findIndex((t) => t.startsWith('insert into "channels"'));
    expect(texts.indexOf('savepoint sp1')).toBeGreaterThan(insertChannel);
    expect(texts).toContain('rollback to savepoint sp1');
    expect(texts.some((t) => t.startsWith('insert into "user_channels"'))).toBe(true);
    expect(texts.at(-1)).toBe('commit');
    warn.mockRestore();
  });

  it('setChannelTgId releases other holders, then sets it, in a savepoint', async () => {
    const { db, queries } = recordingDb();
    await setChannelTgId(db, 'toporlive', 1754252633);
    expect(queries.map((q) => shape(q.text))).toEqual(['begin', ...TG_STEP, 'commit']);
    expect(queries[2]?.params).toEqual([null, 1754252633, 'toporlive']);
    expect(queries[3]?.params).toEqual([1754252633, 'toporlive']);
  });
  it('findChannelsByTgIds dedupes ids and skips the query for none', async () => {
    const { db, queries } = recordingDb(() => [[1754252633, 'toporlive', 'Топор Live', true]]);
    expect(await findChannelsByTgIds(db, [])).toEqual([]);
    expect(queries).toHaveLength(0);
    expect(await findChannelsByTgIds(db, [1754252633, 1754252633])).toEqual([
      { tgId: 1754252633, username: 'toporlive', title: 'Топор Live', isAvailable: true },
    ]);
    expect(queries[0]?.text).toContain('"channels"."tg_id" in ($1)');
    expect(queries[0]?.params).toEqual([1754252633]);
  });
});
