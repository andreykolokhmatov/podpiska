import { createHmac, timingSafeEqual } from 'node:crypto';

import { mskDay, mskDayRange } from '@/pipeline/day';

export interface PdfLink {
  url: string;
  fileName: string;
}

export type PdfLinkCheck = 'ok' | 'invalid' | 'expired';

const SIG_BYTES = 32;

/** Derived, so the bot token itself never keys anything outside Telegram's own checks. */
export const pdfLinkKey = (botToken: string): Buffer =>
  createHmac('sha256', botToken).update('pdf-link').digest();

/**
 * Unix seconds of the next 00:00 MSK: one URL per issue per day, so the CDN renders it once
 * a day at most.
 */
export const pdfLinkExpiry = (now: Date): number =>
  Math.floor(mskDayRange(mskDay(now)).end.getTime() / 1000);

const sign = (key: Buffer, id: string, exp: number): Buffer =>
  createHmac('sha256', key).update(`${id}.${exp}`).digest();

export const pdfFileName = (number: number): string => `Podpiska-${number}.pdf`;

export function buildPdfLink(input: {
  appUrl: string;
  key: Buffer;
  issueId: string;
  number: number;
  now: Date;
}): PdfLink {
  const exp = pdfLinkExpiry(input.now);
  const sig = sign(input.key, input.issueId, exp).toString('base64url');
  const query = new URLSearchParams({ exp: String(exp), sig });
  return {
    url: `${input.appUrl}/api/issues/${input.issueId}/pdf?${query.toString()}`,
    fileName: pdfFileName(input.number),
  };
}

/** `exp` and `sig` are raw query values; the id must already be a valid uuid. */
export function verifyPdfLink(input: {
  key: Buffer;
  issueId: string;
  exp: string | null;
  sig: string | null;
  now: Date;
}): PdfLinkCheck {
  if (input.exp === null || input.sig === null || !/^\d{1,12}$/.test(input.exp)) return 'invalid';
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.sig)) return 'invalid';
  const exp = Number(input.exp);
  const given = Buffer.from(input.sig, 'base64url');
  const expected = sign(input.key, input.issueId, exp);
  if (given.length !== SIG_BYTES || !timingSafeEqual(given, expected)) return 'invalid';
  return input.now.getTime() >= exp * 1000 ? 'expired' : 'ok';
}
