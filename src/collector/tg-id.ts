// Client-safe: no Node, cheerio or db imports (used by the Telegram export parser in the browser).

/** Bot API encodes channel/supergroup ids as `-(1e12 + id)`, i.e. a `-100` prefix. */
const BOT_API_CHANNEL_OFFSET = 1_000_000_000_000;

/**
 * Normalizes a Telegram channel id to the bare positive id stored in `channels.tg_id`.
 * Accepts the three shapes we meet: Bot API `-100<id>`, t.me `data-view` `-<id>`, export `<id>`.
 * `botApi: true` accepts only the `-100<id>` shape (a Bot API channel id is never anything else).
 * Anything else (non-integer, zero, out of range) → null.
 */
export function normalizeChannelId(
  raw: unknown,
  options: { botApi?: boolean } = {},
): number | null {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^-?\d{1,16}$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return null;
  }
  if (!Number.isSafeInteger(value) || value === 0) return null;
  if (options.botApi === true && value > -BOT_API_CHANNEL_OFFSET) return null;
  const bare = value <= -BOT_API_CHANNEL_OFFSET ? -value - BOT_API_CHANNEL_OFFSET : Math.abs(value);
  return bare > 0 && bare < BOT_API_CHANNEL_OFFSET ? bare : null;
}
