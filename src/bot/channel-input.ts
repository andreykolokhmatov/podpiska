import type { Message, MessageEntity } from 'grammy/types';

import { InvalidChannelError, normalizeChannel, normalizeChannelId } from '@/collector';

export type ChannelInputError = 'private' | 'not_channel_forward' | 'addlist';

export type ChannelCandidate =
  /** `tgId` (bare) is known only for forwarded posts. */
  | { kind: 'username'; username: string; tgId?: number }
  | { kind: 'error'; reason: ChannelInputError };

const ADDLIST_RE = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/addlist\//i;

function entityValue(source: string, entity: MessageEntity): string | undefined {
  switch (entity.type) {
    case 'text_link':
      return entity.url;
    // Offsets are UTF-16 code units, which is exactly what String#slice indexes.
    case 'url':
    case 'mention':
      return source.slice(entity.offset, entity.offset + entity.length);
    default:
      return undefined;
  }
}

/**
 * Finds the channel a private message points at: a forwarded channel post, or a
 * mention / link entity. Plain words are never treated as usernames.
 */
export function extractChannelCandidate(
  message: Pick<Message, 'forward_origin' | 'text' | 'entities' | 'caption' | 'caption_entities'>,
): ChannelCandidate | null {
  const origin = message.forward_origin;
  if (origin !== undefined) {
    if (origin.type !== 'channel') return { kind: 'error', reason: 'not_channel_forward' };
    const { username } = origin.chat;
    if (username === undefined) return { kind: 'error', reason: 'private' };
    let normalized: string;
    try {
      normalized = normalizeChannel(username);
    } catch {
      return { kind: 'error', reason: 'private' };
    }
    const tgId = normalizeChannelId(origin.chat.id, { botApi: true });
    return tgId === null
      ? { kind: 'username', username: normalized }
      : { kind: 'username', username: normalized, tgId };
  }

  const source = message.text ?? message.caption ?? '';
  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  let firstError: ChannelInputError | undefined;
  for (const entity of entities ?? []) {
    const value = entityValue(source, entity);
    if (value === undefined) continue;
    if (ADDLIST_RE.test(value.trim())) {
      firstError ??= 'addlist';
      continue;
    }
    try {
      return { kind: 'username', username: normalizeChannel(value) };
    } catch (error) {
      if (error instanceof InvalidChannelError && error.reason !== 'invalid') {
        firstError ??= 'private';
      } else if (!(error instanceof InvalidChannelError)) {
        throw error;
      }
    }
  }
  return firstError === undefined ? null : { kind: 'error', reason: firstError };
}
