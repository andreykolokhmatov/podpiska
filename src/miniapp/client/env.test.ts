import { describe, expect, it } from 'vitest';

import {
  initials,
  issueUrl,
  looksLikeTma,
  openedFromApp,
  privacyUrl,
  withFromApp,
  sessionFlagStore,
  takeStartIssue,
  uiPlatform,
  type FlagStore,
} from './env';

describe('uiPlatform', () => {
  it('ios look for iOS and macOS, base for the rest', () => {
    expect(uiPlatform('ios')).toBe('ios');
    expect(uiPlatform('macos')).toBe('ios');
    expect(uiPlatform('android')).toBe('base');
    expect(uiPlatform('tdesktop')).toBe('base');
    expect(uiPlatform(undefined)).toBe('base');
  });
});

describe('issueUrl', () => {
  it('passes tma and theme to the newspaper', () => {
    expect(issueUrl('abc', 'dark')).toBe('/issue/abc?tma=1&theme=dark');
  });

  it('marks issues opened from the app, so Back may use history', () => {
    expect(issueUrl('abc', 'light', true)).toBe('/issue/abc?tma=1&theme=light&from=app');
  });
});

describe('from=app back signal', () => {
  it('appends to bare and query URLs', () => {
    expect(withFromApp('/archive')).toBe('/archive?from=app');
    expect(withFromApp('/channels?add=1')).toBe('/channels?add=1&from=app');
    expect(privacyUrl('dark')).toBe('/privacy?theme=dark&from=app');
  });

  it('only an explicit from=app counts; a launch link has none', () => {
    expect(openedFromApp('?add=1&from=app')).toBe(true);
    expect(openedFromApp('?tma=1&theme=dark')).toBe(false);
    expect(openedFromApp('')).toBe(false);
    expect(openedFromApp('?from=hub')).toBe(false);
  });
});

describe('looksLikeTma', () => {
  it('detects ?tma=1, launch hash or stored launch params', () => {
    expect(looksLikeTma({ search: '?tma=1&theme=dark', hash: '' }, null)).toBe(true);
    expect(looksLikeTma({ search: '', hash: '#tgWebAppData=x' }, null)).toBe(true);
    expect(looksLikeTma({ search: '', hash: '' }, 'tgWebAppData=x')).toBe(true);
  });

  it('plain browser → false (no SDK download)', () => {
    expect(looksLikeTma({ search: '?theme=dark', hash: '' }, null)).toBe(false);
  });
});

describe('initials', () => {
  it('first letters, uppercase, fallback', () => {
    expect(initials('андрей', 'к')).toBe('АК');
    expect(initials('Новости Омска')).toBe('Н');
    expect(initials(null)).toBe('?');
  });
});

describe('takeStartIssue', () => {
  const ID = '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f';
  const memory = (): FlagStore => {
    let value: string | null = null;
    return { get: () => value, set: (v) => void (value = v) };
  };

  it('routes an issue link once, then never again in this session', () => {
    const store = memory();
    expect(takeStartIssue(`issue_${ID}`, store)).toBe(ID);
    expect(takeStartIssue(`issue_${ID}`, store)).toBeNull();
  });

  it('ignores missing or junk start params and does not consume them', () => {
    const store = memory();
    for (const junk of [undefined, '', 'issue_x', `issue_${ID}x`, `ref_${ID}`]) {
      expect(takeStartIssue(junk, store)).toBeNull();
    }
    expect(store.get()).toBeNull();
  });

  it('a different issue link in the same session still routes', () => {
    const store = memory();
    takeStartIssue(`issue_${ID}`, store);
    const other = '00000000-0000-4000-8000-000000000001';
    expect(takeStartIssue(`issue_${other}`, store)).toBe(other);
  });
});

describe('sessionFlagStore', () => {
  it('falls back to memory when storage throws', () => {
    const store = sessionFlagStore('k', () => {
      throw new Error('blocked');
    });
    expect(store.get()).toBeNull();
    store.set('v');
    expect(store.get()).toBe('v');
  });

  it('persists to storage when it works', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as unknown as Storage;
    sessionFlagStore('k', () => storage).set('v');
    expect(sessionFlagStore('k', () => storage).get()).toBe('v');
  });
});
