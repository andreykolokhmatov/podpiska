// Client-safe: runs in the Mini App on a user-picked file. No cheerio, db or Node imports.
import { z } from 'zod';

import { normalizeChannelId } from '@/collector/tg-id';

export const MAX_EXPORT_CHANNELS = 500;
const MAX_NAME_LENGTH = 256;

export interface ExportChannel {
  /** Bare positive Telegram id, as a decimal string. */
  id: string;
  name: string;
}

export interface ParsedTelegramExport {
  channels: ExportChannel[];
  /** True when more than MAX_EXPORT_CHANNELS public channels were found. */
  truncated: boolean;
}

export class TelegramExportError extends Error {
  override readonly name = 'TelegramExportError';

  constructor() {
    super('not a Telegram Desktop JSON export with a chat list');
  }
}

// Only the envelope is strict; single malformed chats are skipped, not fatal.
const exportSchema = z.object({
  chats: z.object({ list: z.array(z.unknown()) }),
});

const chatSchema = z.object({
  type: z.literal('public_channel'),
  id: z.union([z.number(), z.string()]),
  name: z.string().nullish(),
});

/**
 * Public channels from a Telegram Desktop "Export chat history" result.json.
 * Reads `chats.list` only: `left_chats` are channels the user already left.
 * Throws TelegramExportError when `json` is not such an export.
 */
export function parseTelegramExport(json: unknown): ParsedTelegramExport {
  const envelope = exportSchema.safeParse(json);
  if (!envelope.success) throw new TelegramExportError();

  const byId = new Map<string, ExportChannel>();
  for (const item of envelope.data.chats.list) {
    const chat = chatSchema.safeParse(item);
    if (!chat.success) continue;
    const tgId = normalizeChannelId(chat.data.id);
    if (tgId === null) continue;
    const id = String(tgId);
    if (byId.has(id)) continue;
    byId.set(id, { id, name: (chat.data.name ?? '').trim().slice(0, MAX_NAME_LENGTH) });
  }

  const all = [...byId.values()];
  return {
    channels: all.slice(0, MAX_EXPORT_CHANNELS),
    truncated: all.length > MAX_EXPORT_CHANNELS,
  };
}
