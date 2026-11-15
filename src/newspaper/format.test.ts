import { describe, expect, it } from 'vitest';

import type { IssueSource } from '@/pipeline/schema';

import {
  CHANNEL_FORMS,
  MESSAGE_FORMS,
  countLine,
  groupSeparator,
  groupSources,
  isPostUrl,
  normalizeDashes,
  normalizeIssueDashes,
  pluralRu,
} from './format';

const s = (channel: string, label: string, path: string): IssueSource => ({
  channel,
  label,
  postUrl: `https://t.me/${path}`,
});

describe('pluralRu', () => {
  it.each([
    [0, 'сообщений'],
    [1, 'сообщение'],
    [2, 'сообщения'],
    [5, 'сообщений'],
    [11, 'сообщений'],
    [21, 'сообщение'],
    [22, 'сообщения'],
    [111, 'сообщений'],
  ])('%i → %s', (n, form) => {
    expect(pluralRu(n, MESSAGE_FORMS)).toBe(form);
  });

  it('builds the masthead count line', () => {
    expect(countLine(218, 73)).toBe('218 сообщений · 73 канала');
    expect(countLine(21, 1)).toBe('21 сообщение · 1 канал');
    expect(pluralRu(12, CHANNEL_FORMS)).toBe('каналов');
  });
});

describe('groupSources', () => {
  it('single plain source → channel as link text, no prefix', () => {
    expect(groupSources([s('XOR', 'XOR', 'xor/1')])).toEqual([
      { prefix: null, links: [{ text: 'XOR', href: 'https://t.me/xor/1' }] },
    ]);
  });

  it('labels differing from channel → prefix + labels', () => {
    const groups = groupSources([
      s('КОНТЕКСТ', 'Белый дом', 'k/1'),
      s('КОНТЕКСТ', 'Кремль', 'k/2'),
    ]);
    expect(groups).toEqual([
      {
        prefix: 'КОНТЕКСТ',
        links: [
          { text: 'Белый дом', href: 'https://t.me/k/1' },
          { text: 'Кремль', href: 'https://t.me/k/2' },
        ],
      },
    ]);
  });

  it('several plain sources of one channel → numbered', () => {
    const [group] = groupSources([s('XOR', 'XOR', 'x/1'), s('XOR', 'XOR', 'x/2')]);
    expect(group).toEqual({
      prefix: 'XOR',
      links: [
        { text: '1', href: 'https://t.me/x/1' },
        { text: '2', href: 'https://t.me/x/2' },
      ],
    });
  });

  it('repeated label gets its ordinal', () => {
    const [group] = groupSources([
      s('Топор', 'Al Jazeera', 't/1'),
      s('Топор', 'Al Jazeera', 't/2'),
    ]);
    expect(group?.links.map((l) => l.text)).toEqual(['Al Jazeera', '2']);
  });

  it('dedupes URLs, keeps first-appearance channel order, drops non-post URLs', () => {
    const groups = groupSources([
      s('B', 'B', 'b/1'),
      s('A', 'A', 'a/1'),
      s('B', 'B', 'b/1'),
      { channel: 'C', label: 'C', postUrl: 'javascript:alert(1)' },
    ]);
    expect(groups.map((g) => g.links[0]?.text)).toEqual(['B', 'A']);
    expect(groups[0]?.links).toHaveLength(1);
  });

  it('separator is "; " once any group has a prefix', () => {
    const plain = groupSources([s('A', 'A', 'a/1'), s('B', 'B', 'b/1')]);
    expect(groupSeparator(plain)).toBe(' · ');
    const mixed = groupSources([s('A', 'x', 'a/1'), s('B', 'B', 'b/1')]);
    expect(groupSeparator(mixed)).toBe('; ');
  });
});

describe('isPostUrl', () => {
  it('accepts a t.me post link', () => {
    expect(isPostUrl('https://t.me/kontext_channel/80856')).toBe(true);
  });

  it.each([
    'http://t.me/a/1',
    'https://t.me.evil.com/a/1',
    'javascript:alert(1)',
    'https://t.me/a',
    'https://t.me/Kontext/1',
    'https://t.me/a/1?x=1',
  ])('rejects %s', (url) => {
    expect(isPostUrl(url)).toBe(false);
  });
});

describe('normalizeDashes', () => {
  it('turns em dashes into en dashes, spaced or not', () => {
    expect(normalizeDashes('Омск — столица')).toBe('Омск – столица');
    expect(normalizeDashes('Тюмень—Омск — трасса')).toBe('Тюмень–Омск – трасса');
    expect(normalizeDashes('без тире - и – так')).toBe('без тире - и – так');
    expect(normalizeDashes('')).toBe('');
  });

  it('normalizes every text field of an issue but leaves URLs alone', () => {
    const doc = {
      lead: { headline: 'А — Б', sources: [s('a—b', 'пост — 1', 'a/1')] },
      facts: ['x — y'],
      count: 3,
      empty: null,
      weird: { url: 'https://example.com/a—b', href: 'https://t.me/a—b' },
    };
    const out = normalizeIssueDashes(doc);
    expect(out.lead.headline).toBe('А – Б');
    expect(out.lead.sources[0]).toEqual({
      channel: 'a–b',
      label: 'пост – 1',
      postUrl: 'https://t.me/a/1',
    });
    expect(out.facts).toEqual(['x – y']);
    expect(out.count).toBe(3);
    expect(out.empty).toBeNull();
    expect(out.weird).toEqual({ url: 'https://example.com/a—b', href: 'https://t.me/a—b' });
    expect(doc.lead.headline).toBe('А — Б');
  });
});
