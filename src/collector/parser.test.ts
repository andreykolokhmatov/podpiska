import { readFileSync } from 'node:fs';

import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { ChannelUnavailableError, CollectorParseError } from './errors';
import { parseChannelPage, parseChannelTgId, parseViews } from './parser';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}.html`, import.meta.url), 'utf8');

const pages = {
  toporlive: { file: 'toporlive', username: 'toporlive', count: 15, cursor: 207402 },
  ecotopor: { file: 'ecotopor', username: 'ecotopor', count: 18, cursor: 11847 },
  om1_omsk: { file: 'om1_omsk', username: 'om1_omsk', count: 7, cursor: 55662 },
  mediacomputers: { file: 'mediacomputers', username: 'mediacomputers', count: 9, cursor: 10223 },
} as const;

const parse = (key: keyof typeof pages) => parseChannelPage(fixture(pages[key].file), key);

describe('parseChannelPage on real fixtures', () => {
  it.each(Object.entries(pages))('%s: counts, ids, dates, cursor, info', (key, page) => {
    const result = parseChannelPage(fixture(page.file), page.username);
    expect(result.posts).toHaveLength(page.count);
    expect(result.messageNodes).toBe(page.count);
    expect(new Set(result.posts.map((post) => post.tgPostId)).size).toBe(page.count);
    for (const post of result.posts) {
      expect(Number.isNaN(post.publishedAt.getTime())).toBe(false);
      expect(post.text ?? '').not.toMatch(/Please open Telegram|VIEW IN TELEGRAM/);
      expect(post.html ?? '').not.toMatch(/\son[a-z]+=|<script/i);
    }
    expect(result.beforeCursor).toBe(page.cursor);
    expect(result.info.username).toBe(key);
    expect(result.info.title).toBeTruthy();
    expect(result.info.avatarUrl).toMatch(/^https:\/\/cdn4\.telesco\.pe\//);
  });

  it('reads info with original casing', () => {
    const { info } = parse('om1_omsk');
    expect(info).toMatchObject({
      username: 'om1_omsk',
      displayUsername: 'Om1_Omsk',
      title: 'Om1: Новости Омска и России',
    });
    expect(parse('toporlive').info.title).toBe('Топор Live');
  });

  it('parses the exact publication date', () => {
    const post = parse('toporlive').posts.find((p) => p.tgPostId === 207402);
    expect(post?.publishedAt.toISOString()).toBe('2026-11-14T19:03:18.000Z');
  });

  it('uses the message date, not the video duration <time>', () => {
    // 207405 is a video post whose bubble also contains <time class="message_video_duration">.
    const post = parse('toporlive').posts.find((p) => p.tgPostId === 207405);
    expect(post?.publishedAt.toISOString()).toBe('2026-11-14T19:29:59.000Z');
    expect(post?.hasMedia).toBe(true);
    expect(post?.text).toBeTruthy();
  });

  it('excludes the reply quote from text', () => {
    const post = parse('ecotopor').posts.find((p) => p.tgPostId === 11850);
    expect(post?.text).toMatch(/^Главу AMD Лизу Су/);
    expect(post?.text).not.toContain('Дженсен Хуанг уволен с поста генерального директора');
    expect(post?.html).not.toContain('onclick');
  });

  it('does not duplicate album captions', () => {
    const post = parse('mediacomputers').posts.find((p) => p.tgPostId === 10223);
    const occurrences = post?.text?.split('Цвета iPhone 20 Pro').length ?? 0;
    expect(occurrences - 1).toBe(1);
    expect(post?.html).not.toContain('js-message_text');
    expect(post?.hasMedia).toBe(true);
  });

  it('keeps text next to a "not supported" media block', () => {
    const post = parse('mediacomputers').posts.find((p) => p.tgPostId === 10231);
    expect(post?.text).toMatch(/^NVIDIA может/);
    expect(post?.hasMedia).toBe(true);
  });

  it('stores a media-only post with null text', () => {
    const post = parse('om1_omsk').posts.find((p) => p.tgPostId === 55677);
    expect(post).toMatchObject({ text: null, html: null, hasMedia: true, views: 3430 });
  });

  it('turns <br> into newlines and emoji images into their characters', () => {
    const post = parse('mediacomputers').posts.find((p) => p.tgPostId === 10223);
    expect(post?.text).toContain('Apple\n\n// Джон Тернус справился?\n\n@MediaComputers');
  });

  it('throws ChannelUnavailableError on a non-channel page', () => {
    expect(() => parseChannelPage(fixture('missing'), 'nonexistent_zzz12qq')).toThrow(
      ChannelUnavailableError,
    );
  });
});

describe('parseChannelPage on synthetic markup', () => {
  const result = parseChannelPage(fixture('synthetic'), 'synth_chan');

  it('skips service messages and nodes without a datetime; keeps polls as media', () => {
    expect(result.messageNodes).toBe(4);
    expect(result.posts.map((post) => post.tgPostId)).toEqual([101, 103]);
    expect(result.posts[0]).toMatchObject({ text: null, hasMedia: true, views: 1_170_000 });
    expect(result.beforeCursor).toBe(100);
  });

  it('sanitizes html and converts text', () => {
    const post = result.posts[1];
    expect(post?.text).toBe('Line one\nLine two link');
    expect(post?.html).not.toMatch(/onclick|onmouseover|<script|javascript:/i);
    expect(post?.html).toContain('<br>');
  });

  it('falls back to og:* for title and avatar', () => {
    expect(result.info).toEqual({
      username: 'synth_chan',
      displayUsername: 'Synth_Chan',
      title: 'Synthetic Channel',
      avatarUrl: 'https://cdn4.telesco.pe/file/synthetic.jpg',
      tgId: null,
    });
  });

  it('raises CollectorParseError when message markup drifts', () => {
    const drifted = fixture('toporlive')
      .replaceAll('tgme_widget_message_date', 'tgme_widget_message_when')
      .replaceAll('js-message_text', 'js-message_body');
    expect(() => parseChannelPage(drifted, 'toporlive')).toThrow(CollectorParseError);
  });
});

describe('parseViews', () => {
  it.each([
    ['903', 903],
    ['2.91K', 2910],
    ['11.4K', 11_400],
    ['1.17M', 1_170_000],
    ['', null],
    ['n/a', null],
  ])('%j → %s', (raw, expected) => {
    expect(parseViews(raw)).toBe(expected);
  });
});

describe('channel tg id from data-view', () => {
  it.each([
    ['om1_omsk', 1054950922],
    ['toporlive', 1754252633],
    ['ecotopor', 2416194304],
    ['mediacomputers', 1827745282],
  ] as const)('%s → %d', (key, tgId) => {
    expect(parse(key).info.tgId).toBe(tgId);
  });

  it('is null without posts', () => {
    expect(parseChannelPage(fixture('synthetic'), 'synth_chan').info.tgId).toBeNull();
    expect(parseChannelTgId(load(fixture('missing')))).toBeNull();
  });

  const page = (dataView: string) =>
    load(`<div class="tgme_widget_message" data-post="a/1" data-view="${dataView}"></div>`);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['not base64 json', '!!!***'],
    ['not an object', encode(42)],
    ['no c', encode({ p: 1 })],
    ['c as string', encode({ c: '-1754252633' })],
    ['positive c', encode({ c: 1754252633 })],
    ['fractional c', encode({ c: -1.5 })],
    ['empty', ''],
  ])('garbage data-view (%s) → null', (_label, dataView) => {
    expect(parseChannelTgId(page(dataView))).toBeNull();
  });

  it('reads a well-formed synthetic data-view', () => {
    expect(parseChannelTgId(page(encode({ c: -2416194304, p: 5 })))).toBe(2416194304);
  });
});
