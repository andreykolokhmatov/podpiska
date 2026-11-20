import type { Message, MessageEntity } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { extractChannelCandidate } from './channel-input';

type Input = Parameters<typeof extractChannelCandidate>[0];

const text = (value: string, entities: MessageEntity[]): Input => ({ text: value, entities });

const entity = (source: string, part: string, type: 'mention' | 'url'): MessageEntity => ({
  type,
  offset: source.indexOf(part),
  length: part.length,
});

const channelForward = (username?: string, id = -100): Input => ({
  forward_origin: {
    type: 'channel',
    date: 0,
    message_id: 1,
    chat: { id, type: 'channel', title: 'Топор', ...(username ? { username } : {}) },
  },
});

describe('extractChannelCandidate', () => {
  it('takes the username of a forwarded channel post', () => {
    expect(extractChannelCandidate(channelForward('TOPORLIVE'))).toEqual({
      kind: 'username',
      username: 'toporlive',
    });
  });

  it('carries the bare tg id of a forwarded channel (-100 prefix stripped)', () => {
    expect(extractChannelCandidate(channelForward('toporlive', -1001754252633))).toEqual({
      kind: 'username',
      username: 'toporlive',
      tgId: 1754252633,
    });
  });

  it('drops a chat id that is not in Bot API channel form', () => {
    const candidate = extractChannelCandidate(channelForward('toporlive', -1754252633));
    expect(candidate).toEqual({ kind: 'username', username: 'toporlive' });
    expect(candidate && 'tgId' in candidate).toBe(false);
  });

  it('treats a forward from a channel without username as private', () => {
    expect(extractChannelCandidate(channelForward())).toEqual({ kind: 'error', reason: 'private' });
  });

  it.each<NonNullable<Message['forward_origin']>>([
    { type: 'user', date: 0, sender_user: { id: 1, is_bot: false, first_name: 'A' } },
    { type: 'hidden_user', date: 0, sender_user_name: 'Hidden' },
    { type: 'chat', date: 0, sender_chat: { id: -1, type: 'supergroup', title: 'G' } },
  ])('rejects a forward from $type', (origin) => {
    expect(extractChannelCandidate({ forward_origin: origin })).toEqual({
      kind: 'error',
      reason: 'not_channel_forward',
    });
  });

  it('reads a mention entity', () => {
    const source = 'читаю @toporlive каждый день';
    expect(
      extractChannelCandidate(text(source, [entity(source, '@toporlive', 'mention')])),
    ).toEqual({ kind: 'username', username: 'toporlive' });
  });

  it.each(['t.me/toporlive', 'https://t.me/s/toporlive/123'])('reads a url entity %s', (url) => {
    const source = `вот ${url}`;
    expect(extractChannelCandidate(text(source, [entity(source, url, 'url')]))).toEqual({
      kind: 'username',
      username: 'toporlive',
    });
  });

  it('reads a text_link entity', () => {
    const input = text('Топор', [
      { type: 'text_link', offset: 0, length: 5, url: 'https://t.me/toporlive' },
    ]);
    expect(extractChannelCandidate(input)).toEqual({ kind: 'username', username: 'toporlive' });
  });

  it('reads caption entities', () => {
    const caption = 'фото из @toporlive';
    const input: Input = {
      caption,
      caption_entities: [entity(caption, '@toporlive', 'mention')],
    };
    expect(extractChannelCandidate(input)).toEqual({ kind: 'username', username: 'toporlive' });
  });

  it('uses UTF-16 offsets after emoji', () => {
    const source = '📰👍🏽 @toporlive';
    // '📰' and '👍🏽' are 2 and 4 UTF-16 units: the mention starts at offset 7.
    const input = text(source, [{ type: 'mention', offset: 7, length: 10 }]);
    expect(extractChannelCandidate(input)).toEqual({ kind: 'username', username: 'toporlive' });
  });

  it('skips links normalizeChannel rejects and takes the next one', () => {
    const source = 'https://example.com and @toporlive';
    const input = text(source, [
      entity(source, 'https://example.com', 'url'),
      entity(source, '@toporlive', 'mention'),
    ]);
    expect(extractChannelCandidate(input)).toEqual({ kind: 'username', username: 'toporlive' });
  });

  it.each(['https://t.me/+AbCdEf123', 't.me/c/123456/7', 't.me/joinchat/AbC'])(
    'treats %s as private',
    (url) => {
      const source = `link ${url}`;
      expect(extractChannelCandidate(text(source, [entity(source, url, 'url')]))).toEqual({
        kind: 'error',
        reason: 'private',
      });
    },
  );

  it('reports addlist folders', () => {
    const source = 'https://t.me/addlist/AbCdEf';
    expect(extractChannelCandidate(text(source, [entity(source, source, 'url')]))).toEqual({
      kind: 'error',
      reason: 'addlist',
    });
  });

  it('ignores plain words', () => {
    expect(extractChannelCandidate({ text: 'toporlive' })).toBeNull();
    expect(extractChannelCandidate(text('привет', []))).toBeNull();
    expect(extractChannelCandidate({})).toBeNull();
  });
});
