import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPrivacyInfo } from './privacy';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPrivacyInfo', () => {
  it('has no contact and a direct Google route when nothing is set', () => {
    const info = getPrivacyInfo({});
    expect(info).toEqual({ contact: null, llm: { kind: 'direct' } });
    expect(JSON.stringify(info)).not.toMatch(/podpiska_news_bot|andrei_working|proxyapi/i);
  });

  it('turns PRIVACY_CONTACT into a link', () => {
    expect(getPrivacyInfo({ PRIVACY_CONTACT: 'andrei_working' }).contact).toEqual({
      label: '@andrei_working',
      href: 'https://t.me/andrei_working',
    });
  });

  it('hides an invalid contact and logs only the key name', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(getPrivacyInfo({ PRIVACY_CONTACT: 'javascript:alert(1)' }).contact).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('PRIVACY_CONTACT'));
    expect(String(error.mock.calls[0]?.[0])).not.toContain('javascript');
  });

  it('names the proxy host from LLM_BASE_URL', () => {
    expect(getPrivacyInfo({ LLM_BASE_URL: 'https://api.proxyapi.ru/google/v1beta' }).llm).toEqual({
      kind: 'proxy',
      host: 'api.proxyapi.ru',
    });
  });

  it('treats an explicit Google API base URL as direct', () => {
    expect(
      getPrivacyInfo({ LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta' }).llm,
    ).toEqual({ kind: 'direct' });
  });

  it('reports an invalid base URL as an unknown proxy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(getPrivacyInfo({ LLM_BASE_URL: 'ftp://x.example' }).llm).toEqual({
      kind: 'proxy',
      host: null,
    });
  });
});
