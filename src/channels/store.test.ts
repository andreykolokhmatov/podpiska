/** SQL-level checks of the bulk link: one transaction, user row locked, limit applied in order. */
import { describe, expect, it } from 'vitest';

import { recordingDb } from '@/db/__fixtures__/recording-db';

import { createChannelsDbStore } from './store';

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
