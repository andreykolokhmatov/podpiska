/**
 * The shared issue card and the start_param it opens with. Pure and free of server-only imports:
 * the client imports parseStartParam.
 */
import type { InlineQueryResultArticle } from 'grammy/types';

const START_PREFIX = 'issue_';
const START_PARAM = /^issue_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Keeps the card short; Telegram's own limit (4096) is far above. */
export const SHARE_HEADLINE_MAX = 200;

export interface ShareInput {
  issueId: string;
  number: number;
  headline: string | null;
  botUsername: string;
}

/** `issue_<uuid>`: 42 chars of [a-z0-9_-], within Telegram's startapp limits. */
export const issueStartParam = (issueId: string): string => `${START_PREFIX}${issueId}`;

/** Opens the Mini App straight on the issue, from any chat. */
export const issueStartUrl = (botUsername: string, issueId: string): string =>
  `https://t.me/${botUsername}?startapp=${issueStartParam(issueId)}`;

/** The issue id of an `issue_<uuid>` start_param; null for anything else. */
export function parseStartParam(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return START_PARAM.exec(value)?.[1] ?? null;
}

const truncate = (text: string, max: number): string => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  const kept = chars.slice(0, max - 1).join('');
  return `${kept.trimEnd()}…`;
};

export function shareTitle(number: number, headline: string | null): string {
  const clean = headline === null ? '' : truncate(headline, SHARE_HEADLINE_MAX);
  return clean === '' ? `Выпуск №${number}` : `Выпуск №${number} · ${clean}`;
}

/**
 * Plain text (no parse_mode, so a headline cannot inject markup) and a url button only: a
 * web_app button would not work for the recipients of a shared message.
 */
export function buildShareResult(input: ShareInput): InlineQueryResultArticle {
  const title = shareTitle(input.number, input.headline);
  return {
    type: 'article',
    id: input.issueId.replaceAll('-', ''),
    title,
    description: `Собрано в @${input.botUsername}`,
    input_message_content: {
      message_text: `${title}\n\nСобрано в @${input.botUsername}`,
      link_preview_options: { is_disabled: true },
    },
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Читать газету', url: issueStartUrl(input.botUsername, input.issueId) }],
      ],
    },
  };
}
