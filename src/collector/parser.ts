import { type Cheerio, type CheerioAPI, contains, load } from 'cheerio';

import { ChannelUnavailableError, CollectorParseError } from './errors';
import { normalizeChannelId } from './tg-id';
import type { ChannelInfo, ParsedPost } from './types';

type AnyNode = Parameters<typeof contains>[0];
type Selection = Cheerio<AnyNode>;

export interface ParsedChannelPage {
  info: ChannelInfo;
  posts: ParsedPost[];
  /** Pass as `?before=` to load older posts; null when the page has none. */
  beforeCursor: number | null;
  /** Number of `.tgme_widget_message[data-post]` nodes on the page (posts + skipped). */
  messageNodes: number;
}

const MEDIA_SELECTOR = [
  '.tgme_widget_message_photo_wrap',
  '.tgme_widget_message_video_player',
  '.tgme_widget_message_roundvideo_player',
  '.tgme_widget_message_grouped_wrap',
  '.tgme_widget_message_document',
  '.tgme_widget_message_document_wrap',
  '.tgme_widget_message_voice',
  '.tgme_widget_message_sticker_wrap',
  '.tgme_widget_message_poll',
  '.message_media_not_supported',
].join(', ');

// Media inside these belongs to a quoted or previewed message, not to the post itself.
const FOREIGN_SELECTOR = '.tgme_widget_message_reply, .tgme_widget_message_link_preview';

const BLOCK_TAGS = new Set(['blockquote', 'pre', 'div', 'p']);

/** `903`, `2.91K`, `11.4K`, `1.17M` → integer; anything else → null. */
export function parseViews(raw: string | undefined | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMB]?)\s*$/i.exec(raw ?? '');
  if (!match?.[1]) {
    return null;
  }
  const multiplier = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? '').toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

function collapseText(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

export function htmlToText($: CheerioAPI, node: Selection): string | null {
  const copy = node.clone();
  copy.find('script, style').remove();
  copy.find('br').replaceWith('\n');
  copy.find('*').each((_, el) => {
    if ('tagName' in el && BLOCK_TAGS.has(el.tagName.toLowerCase())) {
      $(el).before('\n').after('\n');
    }
  });
  copy.find('i.emoji').each((_, el) => {
    const emoji = $(el);
    emoji.replaceWith(emoji.text());
  });
  return collapseText(copy.text());
}

/** Drops scripts and every inline handler/style; the result is still untrusted HTML. */
export function sanitizeHtml($: CheerioAPI, node: Selection): string | null {
  const copy = node.clone();
  copy.find('script, style, iframe, object, embed').remove();
  copy.find('*').each((_, el) => {
    if (!('attribs' in el)) {
      return;
    }
    for (const name of Object.keys(el.attribs)) {
      const lower = name.toLowerCase();
      const value = el.attribs[name] ?? '';
      if (
        lower.startsWith('on') ||
        lower === 'style' ||
        ((lower === 'href' || lower === 'src') && /^\s*javascript:/i.test(value))
      ) {
        $(el).removeAttr(name);
      }
    }
  });
  const html = (copy.html() ?? '').trim();
  return html === '' ? null : html;
}

function messageTextNode($: CheerioAPI, bubble: Selection): Selection | null {
  // t.me wraps captions of media posts in `.media_supported_cont`, so the text is not always a
  // direct child of the bubble. Take the outermost `.js-message_text` outside replies/previews.
  let node = bubble
    .find('.js-message_text')
    .filter(
      (_, el) =>
        $(el).parents('.js-message_text').length === 0 &&
        $(el).closest(FOREIGN_SELECTOR).length === 0,
    )
    .first();
  if (node.length === 0) {
    return null;
  }
  // Albums wrap the caption in a second `.js-message_text`; unwrap it so text is not doubled.
  while (node.children().length === 1 && node.children('.js-message_text').length === 1) {
    node = node.children('.js-message_text').first();
  }
  return node;
}

function hasOwnMedia($: CheerioAPI, bubble: Selection): boolean {
  return bubble
    .find(MEDIA_SELECTOR)
    .toArray()
    .some((el) => $(el).closest(FOREIGN_SELECTOR).length === 0);
}

/**
 * The channel id from the first message's `data-view` (base64url JSON, `c` = `-<id>`).
 * Undocumented t.me markup, so any surprise yields null instead of failing the collect.
 */
export function parseChannelTgId($: CheerioAPI): number | null {
  const raw = $('.tgme_widget_message[data-view]').first().attr('data-view');
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof data !== 'object' || data === null || !('c' in data)) return null;
    const { c } = data;
    return typeof c === 'number' && c < 0 ? normalizeChannelId(c) : null;
  } catch {
    return null;
  }
}

function parseChannelInfo($: CheerioAPI, fallbackUsername: string | null): ChannelInfo | null {
  const headerUsername = $('.tgme_channel_info_header_username a').first().text().trim();
  const displayUsername = headerUsername.replace(/^@/, '') || fallbackUsername;
  if (!displayUsername) {
    return null;
  }
  const title =
    $('.tgme_channel_info_header_title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    null;
  const avatarUrl =
    $('.tgme_channel_info_header .tgme_page_photo_image img').first().attr('src') ||
    $('.tgme_page_photo_image img').first().attr('src') ||
    $('meta[property="og:image"]').attr('content') ||
    null;
  return {
    username: displayUsername.toLowerCase(),
    displayUsername,
    title,
    avatarUrl,
    tgId: parseChannelTgId($),
  };
}

/**
 * Parses one `t.me/s/<username>` page. Throws ChannelUnavailableError for pages that are
 * not a channel preview and CollectorParseError when the markup no longer matches.
 */
export function parseChannelPage(html: string, expectedUsername?: string): ParsedChannelPage {
  const $ = load(html);

  if ($('.tgme_channel_history').length === 0 && $('.tgme_channel_info').length === 0) {
    throw new ChannelUnavailableError(
      'not_found_or_preview_disabled',
      'channel not found or its web preview is disabled',
    );
  }

  const expected = expectedUsername?.toLowerCase() ?? null;
  const posts: ParsedPost[] = [];
  let firstChannelPart: string | null = null;
  let minId: number | null = null;
  let serviceSkipped = 0;

  const nodes = $('.tgme_widget_message[data-post]').toArray();
  for (const el of nodes) {
    const message = $(el);
    const [channelPart, idPart] = (message.attr('data-post') ?? '').split('/');
    const tgPostId = Number(idPart);
    if (!channelPart || !Number.isSafeInteger(tgPostId) || tgPostId <= 0) {
      continue;
    }
    if (expected !== null && channelPart.toLowerCase() !== expected) {
      continue;
    }
    firstChannelPart ??= channelPart;
    minId = minId === null ? tgPostId : Math.min(minId, tgPostId);

    if (message.hasClass('service_message')) {
      serviceSkipped += 1;
      continue;
    }
    const datetime = message
      .find('.tgme_widget_message_date time[datetime]')
      .first()
      .attr('datetime');
    const publishedAt = datetime ? new Date(datetime) : null;
    if (publishedAt === null || Number.isNaN(publishedAt.getTime())) {
      continue;
    }

    const bubble = message.children('.tgme_widget_message_bubble').first();
    const scope = bubble.length > 0 ? bubble : message;
    const textNode = messageTextNode($, scope);
    const text = textNode ? htmlToText($, textNode) : null;
    const hasMedia = hasOwnMedia($, scope);
    if (text === null && !hasMedia) {
      continue;
    }

    const viewsNode = scope
      .find('.tgme_widget_message_views')
      .filter((_, v) => $(v).closest(FOREIGN_SELECTOR).length === 0)
      .first();

    posts.push({
      tgPostId,
      text,
      html: textNode && text !== null ? sanitizeHtml($, textNode) : null,
      publishedAt,
      views: viewsNode.length > 0 ? parseViews(viewsNode.text()) : null,
      hasMedia,
    });
  }

  if (nodes.length > 0 && posts.length === 0 && serviceSkipped < nodes.length) {
    throw new CollectorParseError(
      `found ${nodes.length} message nodes but parsed no posts; t.me markup may have changed`,
    );
  }

  const info = parseChannelInfo($, expectedUsername ?? firstChannelPart);
  if (info === null) {
    throw new CollectorParseError('could not determine channel username from the page');
  }
  if (expected !== null) {
    info.username = expected;
  }

  const moreBefore = Number($('a.js-messages_more[data-before]').first().attr('data-before'));
  const beforeCursor =
    minId ?? (Number.isSafeInteger(moreBefore) && moreBefore > 0 ? moreBefore : null);

  return { info, posts, beforeCursor, messageNodes: nodes.length };
}
