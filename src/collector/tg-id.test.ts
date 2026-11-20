import { describe, expect, it } from 'vitest';

import { normalizeChannelId } from './tg-id';

describe('normalizeChannelId', () => {
  it.each([
    ['Bot API -100 id', -1001754252633, 1754252633],
    ['data-view negative id', -2416194304, 2416194304],
    ['export bare id', 1054950922, 1054950922],
    ['numeric string', '1827745282', 1827745282],
    ['Bot API string', '-1001827745282', 1827745282],
  ])('%s', (_label, raw, expected) => {
    expect(normalizeChannelId(raw)).toBe(expected);
  });

  it.each([
    0,
    -0,
    1.5,
    Number.NaN,
    2 ** 53,
    -1_000_000_000_000,
    1_000_000_000_000,
    '',
    'abc',
    '12a',
    null,
    undefined,
    {},
    10n,
  ])('rejects %s', (raw) => {
    expect(normalizeChannelId(raw)).toBeNull();
  });

  it('botApi accepts only the -100 shape', () => {
    expect(normalizeChannelId(-1001754252633, { botApi: true })).toBe(1754252633);
    expect(normalizeChannelId(-1754252633, { botApi: true })).toBeNull();
    expect(normalizeChannelId(1754252633, { botApi: true })).toBeNull();
  });
});
