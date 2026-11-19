import { describe, expect, it } from 'vitest';

import { extractChannelCandidates, isLikelyBot } from './extract';

const names = (text: string): string[] =>
  extractChannelCandidates(text).candidates.map((candidate) => candidate.username);

describe('extractChannelCandidates', () => {
  it.each([
    ['t.me/durovchan', 'durovchan'],
    ['https://t.me/DurovChan', 'durovchan'],
    ['http://www.t.me/durovchan', 'durovchan'],
    ['https://t.me/s/durovchan', 'durovchan'],
    ['telegram.me/durovchan', 'durovchan'],
    ['https://telegram.dog/durovchan', 'durovchan'],
    ['durovchan.t.me', 'durovchan'],
    ['https://durovchan.t.me', 'durovchan'],
    ['https://t.me/durovchan/123', 'durovchan'],
    ['https://t.me/durovchan?single', 'durovchan'],
    ['https://t.me/s/durovchan/123?before=5#x', 'durovchan'],
    ['tg://resolve?domain=durovchan&post=5', 'durovchan'],
    ['https://web.telegram.org/k/#@durovchan', 'durovchan'],
    ['https://web.telegram.org/a/#@durovchan', 'durovchan'],
    ['web.telegram.org/a/#durovchan', 'durovchan'],
    ['@durovchan', 'durovchan'],
    ['[Канал](https://t.me/durovchan)', 'durovchan'],
    ['(t.me/durovchan)', 'durovchan'],
    ['[t.me/durovchan]', 'durovchan'],
    ['t.me/durovchan.', 'durovchan'],
    ['t.me/durovchan,', 'durovchan'],
    ['t.me/durovchan;', 'durovchan'],
    ['t.me/durovchan:', 'durovchan'],
    ['t.me/durovchan!', 'durovchan'],
    ['t.me/durovchan?', 'durovchan'],
    ['«t.me/durovchan»', 'durovchan'],
    ['"t.me/durovchan"', 'durovchan'],
    ['см. @durovchan.', 'durovchan'],
    ['“t.me/durovchan”', 'durovchan'],
    ['„t.me/durovchan“', 'durovchan'],
    ['‘t.me/durovchan’', 'durovchan'],
    ['‹t.me/durovchan›', 'durovchan'],
    ['t.me/durovchan—канал', 'durovchan'],
    ['t.me/durovchan–канал', 'durovchan'],
    ['https://t.me/durovchan/5—пост', 'durovchan'],
    ['“@durovchan”', 'durovchan'],
    ['tg://resolve?domain=durovchan”', 'durovchan'],
    ['“https://web.telegram.org/a/#@durovchan”', 'durovchan'],
    ['“durovchan.t.me”', 'durovchan'],
  ])('%j → %s', (text, expected) => {
    expect(names(text)).toEqual([expected]);
  });

  it.each([
    ['t.me/+AbCdEf123', 1],
    ['https://t.me/joinchat/AbCdEf', 1],
    ['t.me/addlist/AbCdEf', 1],
    ['https://t.me/c/1234567/89', 1],
    ['t.me/share/url?url=x', 1],
    ['t.me/proxy?server=x', 1],
    ['t.me/addstickers/pack', 1],
    ['t.me/contact/abcdef', 1],
    ['t.me/giftcode/abcdef', 1],
    ['t.me/nft/gift-1', 1],
    ['t.me/stars', 1],
    ['t.me/premium_offer', 1],
    ['t.me/bg/abc', 1],
    ['t.me/addpremium', 1],
    ['t.me/abc', 1],
    ['t.me/bad-name', 1],
    ['tg://join?invite=AbCd', 1],
    ['web.telegram.org/a/#-1001234567', 1],
    ['a@b.com', 0],
    ['mail me: someone@example.com', 0],
    ['@ab', 0],
    ['@gmail.com', 0],
    ['https://example.com/@durovchan', 0],
    ['example.com/redirect/t.me/durovchan', 0],
    ['https://example.com/go/https://t.me/durovchan', 0],
    ['https://example.com/?u=t.me/durovchan', 0],
    ['https://example.com/?u=@durovchan', 0],
    ['https://example.com/r/durovchan.t.me', 0],
  ])('%j is no candidate (skipped %i)', (text, skipped) => {
    const result = extractChannelCandidates(text);
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toBe(skipped);
  });

  it('dedupes case-insensitively, keeping first-appearance order across forms', () => {
    const text = [
      'Читаю @Second_chan и https://t.me/first_chan',
      'а ещё t.me/s/SECOND_CHAN/5, third_chan.t.me',
      'tg://resolve?domain=first_chan',
      '[x](https://t.me/fourth_chan) @third_chan',
    ].join('\n');
    expect(names(text)).toEqual(['second_chan', 'first_chan', 'third_chan', 'fourth_chan']);
  });

  it('flags bot names', () => {
    const { candidates } = extractChannelCandidates('@podpiska_news_bot t.me/SomeBot @news_chan');
    expect(candidates).toEqual([
      { username: 'podpiska_news_bot', bot: true },
      { username: 'somebot', bot: true },
      { username: 'news_chan', bot: false },
    ]);
  });

  it('truncates at maxCandidates', () => {
    const text = Array.from({ length: 5 }, (_, i) => `@channel_${i}`).join(' ');
    const result = extractChannelCandidates(`${text} @channel_0`, { maxCandidates: 3 });
    expect(result.candidates.map((c) => c.username)).toEqual([
      'channel_0',
      'channel_1',
      'channel_2',
    ]);
    expect(result.truncated).toBe(true);
    expect(extractChannelCandidates(text, { maxCandidates: 5 }).truncated).toBe(false);
  });

  it('handles 50k chars of mixed and hostile input quickly', () => {
    const chunk =
      'https://t.me/s/channel_a/1?x=1 @@@@@ t.me/+zz a@b.c ....t.me/// tg://resolve?domain= ';
    const text = chunk.repeat(Math.floor(45_000 / chunk.length)) + '@'.repeat(5000);
    expect(text.length).toBeLessThanOrEqual(50_000);
    const started = performance.now();
    const result = extractChannelCandidates(text);
    expect(performance.now() - started).toBeLessThan(50);
    expect(result.candidates.map((c) => c.username)).toEqual(['channel_a']);
  });

  it('isLikelyBot', () => {
    expect(isLikelyBot('somebot')).toBe(true);
    expect(isLikelyBot('robotics_news')).toBe(false);
  });
});
