/**
 * Pulls public channel usernames out of arbitrary pasted text. Client-safe: imports only the
 * pure normalizer, never the collector index (which pulls cheerio into the browser bundle).
 */
import { InvalidChannelError } from './errors';
import { normalizeChannel } from './normalize';

export const EXTRACT_CANDIDATES_MAX = 500;

export interface ChannelCandidate {
  /** Lowercase, valid Telegram username. */
  username: string;
  /** Name ends in "bot": Telegram reserves that suffix for bots, never a channel. */
  bot: boolean;
}

export interface ExtractResult {
  /** Unique, in order of first appearance, at most maxCandidates. */
  candidates: ChannelCandidate[];
  /** Links that are not public channels: invites, private /c/ links, service paths, bad names. */
  skipped: number;
  /** More unique candidates were found than maxCandidates. */
  truncated: boolean;
}

export const isLikelyBot = (username: string): boolean => /bot$/i.test(username);

// Every pattern is a flat scan (no nested quantifiers) so 50k chars of hostile input stay linear.
// A link tail stops at whitespace, quotes (ASCII and typographic), brackets, dashes and the
// query/fragment.
const STOP = String.raw`\s"'<>()\[\]{}«»“”„‟‘’‚‛‹›—–`;
const TAIL = `[^${STOP}?#]*`;
// Not inside a path or a query value: `example.com/redirect/t.me/x`, `?u=@x`.
const NOT_EMBEDDED = String.raw`(?<![\w.\-@/=])`;

/** t.me/x, t.me/s/x, telegram.me/x, telegram.dog/x (with or without scheme); group 1 = path. */
const LINK_RE = new RegExp(
  String.raw`${NOT_EMBEDDED}(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(${TAIL})`,
  'gi',
);
/** x.t.me; group 1 = subdomain. */
const SUBDOMAIN_RE = new RegExp(
  String.raw`${NOT_EMBEDDED}(?:https?:\/\/)?(?!www\.)([a-z0-9_]+)\.t\.me(?![\w.-])`,
  'gi',
);
/** tg://resolve?domain=x; group 1 = host, group 2 = query. */
const TG_RE = new RegExp(String.raw`(?<![\w.-])tg:\/\/([a-z]+)\?([^${STOP}]*)`, 'gi');
/** web.telegram.org/k/#@x, /a/#@x, /a/#-100… ; group 1 = fragment. */
const WEB_RE = new RegExp(
  String.raw`(?<![\w.-])(?:https?:\/\/)?web\.telegram\.org\/[a-z]\/#([^${STOP}?]*)`,
  'gi',
);
/** @x not inside an email, a path or a query value; group 1 = name. */
const MENTION_RE = /(?<![\w.@/=])@([a-z0-9_]+)(?!\w|\.[a-z0-9])/gi;

const TRAILING_PUNCT = /[.,;:!?…"'»”“„’‘—–]+$/;

type Hit = { index: number; username: string | null };

function normalizedOrNull(input: string): string | null {
  try {
    return normalizeChannel(input);
  } catch (error) {
    if (error instanceof InvalidChannelError) return null;
    throw error;
  }
}

function scan(text: string, re: RegExp, toHit: (match: RegExpExecArray) => string | null): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(re)) {
    hits.push({ index: match.index, username: toHit(match) });
  }
  return hits;
}

const fromLinkPath = (path: string): string | null => {
  const cleaned = path.replace(TRAILING_PUNCT, '');
  return normalizedOrNull(`https://t.me/${cleaned}`);
};

const fromTg = (host: string, query: string): string | null => {
  if (host.toLowerCase() !== 'resolve') return null;
  const domain = new URLSearchParams(query.replace(TRAILING_PUNCT, '')).get('domain');
  if (domain === null || domain.startsWith('@') || domain.startsWith('+')) return null;
  return normalizedOrNull(domain);
};

const fromWeb = (fragment: string): string | null => {
  const name = fragment.replace(TRAILING_PUNCT, '').replace(/^@/, '');
  // Numeric fragments (#-100123…) are private chat ids.
  if (name === '' || /^-?\d+$/.test(name)) return null;
  return normalizedOrNull(name);
};

/**
 * Finds every public channel username in `text`: t.me / telegram.me / telegram.dog links (incl.
 * /s/, post links and query strings), x.t.me, tg://resolve?domain=, web.telegram.org/#@x and
 * @mentions. Lowercased, deduplicated, in order of first appearance.
 */
export function extractChannelCandidates(
  text: string,
  options: { maxCandidates?: number } = {},
): ExtractResult {
  const max = options.maxCandidates ?? EXTRACT_CANDIDATES_MAX;
  // Mentions that are not valid names are ordinary text, not skipped links.
  const mentions = scan(text, MENTION_RE, (m) => normalizedOrNull(m[1] ?? '')).filter(
    (hit) => hit.username !== null,
  );
  const hits = [
    ...scan(text, LINK_RE, (m) => fromLinkPath(m[1] ?? '')),
    ...scan(text, SUBDOMAIN_RE, (m) => normalizedOrNull(`${m[1] ?? ''}.t.me`)),
    ...scan(text, TG_RE, (m) => fromTg(m[1] ?? '', m[2] ?? '')),
    ...scan(text, WEB_RE, (m) => fromWeb(m[1] ?? '')),
    ...mentions,
  ].sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const candidates: ChannelCandidate[] = [];
  let skipped = 0;
  let truncated = false;
  for (const { username } of hits) {
    if (username === null) {
      skipped += 1;
      continue;
    }
    if (seen.has(username)) continue;
    seen.add(username);
    if (candidates.length >= max) {
      truncated = true;
      continue;
    }
    candidates.push({ username, bot: isLikelyBot(username) });
  }
  return { candidates, skipped, truncated };
}
