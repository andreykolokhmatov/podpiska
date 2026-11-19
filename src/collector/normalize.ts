import { InvalidChannelError } from './errors';

const USERNAME_RE = /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/;
const TG_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);
const RESERVED_PATHS = new Set([
  'addstickers',
  'addemoji',
  'addtheme',
  'share',
  'proxy',
  'socks',
  'iv',
  'boost',
  'addlist',
  'login',
  'setlanguage',
  'confirmphone',
  'invoice',
  'contact',
  'giftcode',
  'nft',
  'stars',
  'premium_offer',
  'premium_multigift',
  'addpremium',
  'bg',
  'm',
  'web',
]);

function checkUsername(candidate: string, input: string): string {
  const username = candidate.toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new InvalidChannelError('invalid', `"${input}" is not a valid channel username`);
  }
  return username;
}

function fromPath(segments: string[], input: string): string {
  const [head, second] = segments;
  let first = head;
  if (first === undefined || first === '') {
    throw new InvalidChannelError('invalid', `"${input}" has no channel in the link`);
  }
  if (first.startsWith('+') || first.toLowerCase() === 'joinchat') {
    throw new InvalidChannelError('invite_link', `"${input}" is an invite link`);
  }
  if (first.toLowerCase() === 'c') {
    throw new InvalidChannelError('private_link', `"${input}" is a private channel link`);
  }
  if (first.toLowerCase() === 's') {
    first = second;
    if (first === undefined || first === '') {
      throw new InvalidChannelError('invalid', `"${input}" has no channel in the link`);
    }
  }
  if (RESERVED_PATHS.has(first.toLowerCase())) {
    throw new InvalidChannelError('invalid', `"${input}" is not a channel link`);
  }
  return checkUsername(first, input);
}

/** Accepts `@name`, `name`, and t.me-style links; returns the lowercase username. */
export function normalizeChannel(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new InvalidChannelError('invalid', 'channel is empty');
  }

  const looksLikeUrl = /^(https?:\/\/)/i.test(trimmed) || /^[^/@\s]+\.[^/\s]+(\/|$)/.test(trimmed);
  if (!looksLikeUrl) {
    const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    if (bare.startsWith('+')) {
      throw new InvalidChannelError('invite_link', `"${input}" is an invite link`);
    }
    return checkUsername(bare, input);
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new InvalidChannelError('invalid', `"${input}" is not a valid link`);
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter((segment) => segment !== '');

  if (TG_HOSTS.has(host)) {
    return fromPath(segments, input);
  }
  if (host.endsWith('.t.me')) {
    return checkUsername(host.slice(0, -'.t.me'.length), input);
  }
  throw new InvalidChannelError('invalid', `"${input}" is not a Telegram link`);
}

/** Telegram usernames are case-insensitive; links are canonical lowercase. */
export function postUrl(username: string, tgPostId: number): string {
  return `https://t.me/${username.toLowerCase()}/${tgPostId}`;
}
