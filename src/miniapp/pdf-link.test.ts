import { describe, expect, it } from 'vitest';

import { buildPdfLink, pdfLinkExpiry, pdfLinkKey, verifyPdfLink } from './pdf-link';

const ID = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e';
const KEY = pdfLinkKey('111111:prod-token');
const APP = 'https://podpiska.example';
// 15 Nov 2026, 12:00 MSK; the MSK day ends at 2026-11-15T21:00:00Z.
const now = new Date('2026-11-15T09:00:00Z');
const END = Date.parse('2026-11-15T21:00:00Z') / 1000;

const link = (at = now) => buildPdfLink({ appUrl: APP, key: KEY, issueId: ID, number: 7, now: at });

const parts = (url: string) => {
  const parsed = new URL(url);
  return { exp: parsed.searchParams.get('exp'), sig: parsed.searchParams.get('sig') };
};

describe('pdf link', () => {
  it('signs a link to the PDF route that verifies until 00:00 MSK', () => {
    const { url, fileName } = link();
    expect(fileName).toBe('Podpiska-7.pdf');
    expect(url.startsWith(`${APP}/api/issues/${ID}/pdf?`)).toBe(true);
    const { exp, sig } = parts(url);
    expect(Number(exp)).toBe(END);
    expect(verifyPdfLink({ key: KEY, issueId: ID, exp, sig, now })).toBe('ok');
  });

  it('is stable within one MSK day and changes the next day', () => {
    expect(link(new Date('2026-11-14T21:00:00Z')).url).toBe(link().url);
    expect(link(new Date('2026-11-15T20:59:59Z')).url).toBe(link().url);
    expect(link(new Date('2026-11-15T21:00:00Z')).url).not.toBe(link().url);
    expect(pdfLinkExpiry(new Date('2026-11-15T21:00:00Z'))).toBe(END + 86_400);
  });

  it('expires at the end of the day', () => {
    const { exp, sig } = parts(link().url);
    const at = new Date(END * 1000);
    expect(verifyPdfLink({ key: KEY, issueId: ID, exp, sig, now: at })).toBe('expired');
  });

  it('rejects tampering, another issue, another key and junk', () => {
    const { exp, sig } = parts(link().url);
    const other = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5f';
    const check = (input: { issueId?: string; exp?: string | null; sig?: string | null }) =>
      verifyPdfLink({ key: KEY, issueId: ID, exp, sig, now, ...input });
    expect(check({ issueId: other })).toBe('invalid');
    expect(check({ exp: String(END + 86_400) })).toBe('invalid');
    expect(check({ sig: `${sig?.startsWith('A') ? 'B' : 'A'}${sig?.slice(1)}` })).toBe('invalid');
    expect(check({ sig: null })).toBe('invalid');
    expect(check({ exp: null })).toBe('invalid');
    expect(check({ exp: '1e12' })).toBe('invalid');
    expect(check({ sig: 'short' })).toBe('invalid');
    expect(verifyPdfLink({ key: pdfLinkKey('222222:dev-token'), issueId: ID, exp, sig, now })).toBe(
      'invalid',
    );
  });
});
