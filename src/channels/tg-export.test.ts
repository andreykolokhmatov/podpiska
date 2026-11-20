import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_EXPORT_CHANNELS, TelegramExportError, parseTelegramExport } from './tg-export';

const sample: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/tg-export.json', import.meta.url), 'utf8'),
);

const exportOf = (list: unknown[]) => ({ about: '', chats: { list } });

describe('parseTelegramExport', () => {
  it('keeps public channels of chats.list: normalized, deduped, trimmed', () => {
    expect(parseTelegramExport(sample)).toEqual({
      channels: [
        { id: '1754252633', name: 'Synthetic News' },
        { id: '2416194304', name: 'Eco Synthetic' },
        { id: '1827745282', name: 'Bot API shaped' },
        { id: '1054950922', name: '' },
      ],
      truncated: false,
    });
  });

  it('ignores left_chats', () => {
    const ids = parseTelegramExport(sample).channels.map((c) => c.id);
    expect(ids).not.toContain('4444444444');
  });

  it('caps names at 256 characters', () => {
    const [channel] = parseTelegramExport(
      exportOf([{ type: 'public_channel', id: 1, name: 'x'.repeat(300) }]),
    ).channels;
    expect(channel?.name).toHaveLength(256);
  });

  it(`caps the list at ${MAX_EXPORT_CHANNELS} and flags the truncation`, () => {
    const list = Array.from({ length: MAX_EXPORT_CHANNELS + 1 }, (_, i) => ({
      type: 'public_channel',
      id: i + 1,
      name: `c${i}`,
    }));
    const result = parseTelegramExport(exportOf(list));
    expect(result.channels).toHaveLength(MAX_EXPORT_CHANNELS);
    expect(result.channels.at(-1)?.id).toBe(String(MAX_EXPORT_CHANNELS));
    expect(result.truncated).toBe(true);
  });

  it('returns an empty list for an export without public channels', () => {
    expect(parseTelegramExport(exportOf([]))).toEqual({ channels: [], truncated: false });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'result.json'],
    ['a single-chat export', { name: 'Chat', type: 'personal_chat', id: 1, messages: [] }],
    ['chats without list', { chats: {} }],
    ['chats.list not an array', { chats: { list: {} } }],
  ])('rejects %s', (_label, json) => {
    expect(() => parseTelegramExport(json)).toThrow(TelegramExportError);
  });
});
