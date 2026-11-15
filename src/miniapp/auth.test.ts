import { sign } from '@tma.js/init-data-node';
import { describe, expect, it } from 'vitest';

import { isOwner, parseAuthHeader, verifyInitData } from './auth';

const PROD = '111111:prod-token';
const DEV = '222222:dev-token';
const now = new Date('2026-11-15T12:00:00Z');
const user = { id: 42, first_name: 'Андрей', username: 'andrey', allows_write_to_pm: true };

const signed = (token = PROD, authDate = new Date(now.getTime() - 60_000), data = { user }) =>
  sign(data, token, authDate);

describe('parseAuthHeader', () => {
  it('reads the tma scheme only', () => {
    expect(parseAuthHeader('tma abc=1')).toBe('abc=1');
    expect(parseAuthHeader('TMA abc=1')).toBe('abc=1');
    expect(parseAuthHeader(null)).toBeUndefined();
    expect(parseAuthHeader('Bearer abc')).toBeUndefined();
    expect(parseAuthHeader('tma')).toBeUndefined();
    expect(parseAuthHeader('tma a b')).toBeUndefined();
  });
});

describe('verifyInitData', () => {
  it('accepts prod-signed data', () => {
    const result = verifyInitData(signed(), { prodToken: PROD, now });
    expect(result).toEqual({
      ok: true,
      auth: {
        bot: 'prod',
        user: { id: 42, firstName: 'Андрей', username: 'andrey' },
        allowsWriteToPm: true,
        authDate: expect.any(Date),
      },
    });
  });

  it('accepts dev-signed data only when the dev token is configured', () => {
    const raw = signed(DEV);
    expect(verifyInitData(raw, { prodToken: PROD, now })).toEqual({
      ok: false,
      error: 'unauthorized',
    });
    const result = verifyInitData(raw, { prodToken: PROD, devToken: DEV, now });
    expect(result.ok && result.auth.bot).toBe('dev');
  });

  it('rejects tampered data', () => {
    const raw = signed().replace('%22id%22%3A42', '%22id%22%3A43');
    expect(verifyInitData(raw, { prodToken: PROD, devToken: DEV, now })).toEqual({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('reports expired data older than 24h', () => {
    const raw = signed(PROD, new Date(now.getTime() - 86_401_000));
    expect(verifyInitData(raw, { prodToken: PROD, now })).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('rejects signed data without a user', () => {
    const raw = sign({ query_id: 'q' }, PROD, now);
    expect(verifyInitData(raw, { prodToken: PROD, now })).toEqual({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('rejects empty and oversized input', () => {
    expect(verifyInitData('', { prodToken: PROD, now }).ok).toBe(false);
    expect(verifyInitData('a'.repeat(9000), { prodToken: PROD, now }).ok).toBe(false);
  });

  it('defaults allowsWriteToPm to false', () => {
    const raw = signed(PROD, now, { user: { id: 42, first_name: 'A' } } as never);
    const result = verifyInitData(raw, { prodToken: PROD, now });
    expect(result.ok && result.auth.allowsWriteToPm).toBe(false);
  });
});

describe('isOwner', () => {
  const auth = (bot: 'prod' | 'dev') => ({
    bot,
    user: { id: 42, firstName: 'A', username: null },
    allowsWriteToPm: false,
    authDate: now,
  });

  it('grants owner rights only to prod-signed data of the owner id', () => {
    expect(isOwner(auth('prod'), 42)).toBe(true);
    expect(isOwner(auth('dev'), 42)).toBe(false);
    expect(isOwner(auth('prod'), 7)).toBe(false);
    expect(isOwner(auth('prod'), undefined)).toBe(false);
  });
});
