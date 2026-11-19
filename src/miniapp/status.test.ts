import { describe, expect, it } from 'vitest';

import {
  countsTowardQuota,
  countsTowardSpend,
  errorCode,
  issueState,
  quota,
  quotaDayStart,
  STALE_MS,
  type IssueStateRow,
} from './status';

const now = new Date('2026-11-15T12:00:00Z');
const row = (patch: Partial<IssueStateRow> = {}): IssueStateRow => ({
  id: '0b1c2d3e-0000-4000-8000-000000000001',
  status: 'pending',
  error: null,
  number: null,
  digestsDone: 0,
  digestsTotal: 0,
  createdAt: now,
  ...patch,
});

describe('quota', () => {
  it.each([
    [0, 3],
    [2, 1],
    [3, 0],
    [5, 0],
  ])('used %i leaves %i of 3', (used, remaining) => {
    expect(quota(used, false)).toEqual({ limit: 3, used, remaining });
  });

  it('is null (unlimited) for the owner', () => {
    expect(quota(10, true)).toBeNull();
  });
});

describe('countsTowardQuota', () => {
  it.each(['no_channels: x', 'no_posts: x', 'collect_failed: x', 'no_news: x', 'timeout: x'])(
    'excludes the exempt failure %s',
    (error) => {
      expect(countsTowardQuota({ status: 'failed', error })).toBe(false);
    },
  );

  it.each([
    ['failed', 'digest_failed: x'],
    ['failed', 'Payment Required'],
    ['ready', null],
    ['digesting', null],
  ] as const)('counts %s %s', (status, error) => {
    expect(countsTowardQuota({ status, error })).toBe(true);
  });
});

describe('countsTowardSpend', () => {
  it('counts a timeout globally (it spent digests) but not free failures', () => {
    expect(countsTowardSpend({ status: 'failed', error: 'timeout: x' })).toBe(true);
    expect(countsTowardSpend({ status: 'failed', error: 'no_posts: x' })).toBe(false);
    expect(countsTowardSpend({ status: 'ready', error: null })).toBe(true);
  });
});

describe('quotaDayStart', () => {
  it('resets at 00:00 Moscow time (21:00Z)', () => {
    expect(quotaDayStart(new Date('2026-11-15T20:59:00Z')).toISOString()).toBe(
      '2026-11-14T21:00:00.000Z',
    );
    expect(quotaDayStart(new Date('2026-11-15T21:01:00Z')).toISOString()).toBe(
      '2026-11-15T21:00:00.000Z',
    );
  });
});

describe('errorCode', () => {
  it('reads known code prefixes and hides everything else', () => {
    expect(errorCode('no_posts: nothing')).toBe('no_posts');
    expect(errorCode('timeout: too long')).toBe('timeout');
    expect(errorCode('lead_unsourced: x')).toBe('internal');
    expect(errorCode('Payment Required')).toBe('internal');
    expect(errorCode(null)).toBe('internal');
  });
});

describe('issueState', () => {
  it('reports progress per step', () => {
    expect(issueState(row({ status: 'collecting' }), now).progress).toEqual({
      step: 'collecting',
      done: null,
      total: null,
    });
    expect(
      issueState(row({ status: 'digesting', digestsDone: 2, digestsTotal: 5 }), now).progress,
    ).toEqual({ step: 'digesting', done: 2, total: 5 });
    expect(issueState(row({ status: 'composing' }), now).progress?.step).toBe('composing');
  });

  it('reports a stale in-flight issue as failed/timeout', () => {
    const old = new Date(now.getTime() - STALE_MS - 1000);
    expect(issueState(row({ status: 'digesting', createdAt: old }), now)).toMatchObject({
      status: 'failed',
      error: 'timeout',
      progress: null,
    });
    expect(issueState(row({ status: 'digesting' }), now).status).toBe('digesting');
  });

  it('exposes what was read only for no_news', () => {
    const stats = { messages: 3, channels: 1, collect: {} };
    expect(issueState(row({ status: 'failed', error: 'no_news: x', stats }), now).found).toEqual({
      posts: 3,
      channels: 1,
    });
    expect(issueState(row({ status: 'failed', error: 'no_news: x' }), now)).not.toHaveProperty(
      'found',
    );
    expect(
      issueState(row({ status: 'failed', error: 'digest_failed: x', stats }), now),
    ).not.toHaveProperty('found');
  });

  it('exposes number only when ready and error only when failed', () => {
    expect(issueState(row({ status: 'ready', number: 4 }), now)).toMatchObject({
      number: 4,
      error: null,
      progress: null,
    });
    expect(
      issueState(row({ status: 'failed', error: 'no_posts: x', number: null }), now).error,
    ).toBe('no_posts');
  });
});
