import { describe, expect, it } from 'vitest';

import { initials, issueUrl, looksLikeTma, uiPlatform } from './env';

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
