import { describe, expect, it } from 'vitest';

import { InvalidChannelError } from './errors';
import { normalizeChannel, postUrl } from './normalize';

describe('normalizeChannel', () => {
  it.each([
    ['@toporlive', 'toporlive'],
    ['toporlive', 'toporlive'],
    ['t.me/toporlive', 'toporlive'],
    ['https://t.me/s/toporlive', 'toporlive'],
    ['https://t.me/toporlive/123?single', 'toporlive'],
    ['http://telegram.me/toporlive/', 'toporlive'],
    ['https://telegram.dog/toporlive', 'toporlive'],
    ['toporlive.t.me', 'toporlive'],
    ['https://www.t.me/s/toporlive?before=5#x', 'toporlive'],
    ['  @Om1_Omsk ', 'om1_omsk'],
    ['https://t.me/MediaComputers', 'mediacomputers'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeChannel(input)).toBe(expected);
  });

  it.each([
    ['', 'invalid'],
    ['@', 'invalid'],
    ['t.me/+AbCd', 'invite_link'],
    ['+AbCd', 'invite_link'],
    ['t.me/joinchat/x', 'invite_link'],
    ['t.me/c/123/4', 'private_link'],
    ['t.me/s/', 'invalid'],
    ['t.me/addstickers/x', 'invalid'],
    ['t.me/giftcode/abcdef', 'invalid'],
    ['t.me/premium_offer', 'invalid'],
    ['https://t.me/stars', 'invalid'],
    ['t.me/contact/abcdef', 'invalid'],
    ['t.me/nft/gift-1', 'invalid'],
    ['https://example.com/x', 'invalid'],
    ['abc', 'invalid'],
    ['bad-name', 'invalid'],
    ['name_', 'invalid'],
    ['1abcde', 'invalid'],
    ['a'.repeat(40), 'invalid'],
  ])('%j → InvalidChannelError(%s)', (input, reason) => {
    let caught: unknown;
    try {
      normalizeChannel(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidChannelError);
    expect((caught as InvalidChannelError).reason).toBe(reason);
    expect((caught as InvalidChannelError).code).toBe('InvalidChannel');
  });
});

describe('postUrl', () => {
  it('builds a t.me post link', () => {
    expect(postUrl('toporlive', 207402)).toBe('https://t.me/toporlive/207402');
  });

  it('lowercases a mixed-case username', () => {
    expect(postUrl('Om1_Omsk', 42)).toBe('https://t.me/om1_omsk/42');
  });
});
