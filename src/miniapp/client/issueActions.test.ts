import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  class ShareMessageError extends Error {}
  const button = () => {
    const listeners = new Set<() => void>();
    return {
      listeners,
      setParams: { ifAvailable: vi.fn<(state: Record<string, unknown>) => void>() },
      onClick: {
        ifAvailable: vi.fn((listener: () => void) => {
          listeners.add(listener);
          return { ok: true, data: () => listeners.delete(listener) };
        }),
      },
      click: () => listeners.forEach((l) => l()),
    };
  };
  const feature = <T extends (...args: never[]) => unknown>() =>
    Object.assign(vi.fn<T>(), { isAvailable: vi.fn(() => true), ifAvailable: vi.fn() });
  return {
    AccessDeniedError,
    ShareMessageError,
    mainButton: button(),
    secondaryButton: button(),
    shareMessage: feature<(id: string) => Promise<void>>(),
    downloadFile: feature<(url: string, fileName: string) => Promise<void>>(),
    openLink: feature<(url: string) => void>(),
    openTelegramLink: feature<(url: string) => void>(),
    popup: { show: feature<(options: unknown) => Promise<string>>() },
    hapticFeedback: {
      impactOccurred: { ifAvailable: vi.fn() },
      selectionChanged: { ifAvailable: vi.fn() },
      notificationOccurred: { ifAvailable: vi.fn() },
    },
  };
});

vi.mock('@tma.js/sdk-react', () => sdk);

import { configureApi } from './api';
import { issueIdFromPath, startIssueActions } from './issueActions';

const ID = '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f';
const OPTIONS = { botUsername: 'podpiska_news_bot', origin: 'https://podpiska-news.vercel.app' };

type Route = (method: string, path: string) => [number, unknown];

const ready: [number, unknown] = [
  200,
  { issue: { id: ID, status: 'ready', progress: null, error: null, number: 7 } },
];

let calls: string[];
function backend(route: Route) {
  calls = [];
  configureApi({
    initDataRaw: 'init',
    fetch: async (input, init) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${input}`);
      const [status, body] = route(method, input);
      return new Response(JSON.stringify(body), { status });
    },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastParams = (button: typeof sdk.mainButton) =>
  button.setParams.ifAvailable.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  for (const button of [sdk.mainButton, sdk.secondaryButton]) button.listeners.clear();
  for (const f of [sdk.shareMessage, sdk.downloadFile, sdk.popup.show]) {
    f.isAvailable.mockReturnValue(true);
  }
});

describe('issueIdFromPath', () => {
  it('accepts /issue/<uuid> only', () => {
    expect(issueIdFromPath(`/issue/${ID}`)).toBe(ID);
    expect(issueIdFromPath(`/issue/${ID.toUpperCase()}/`)).toBe(ID);
    expect(issueIdFromPath('/issue/preview')).toBeNull();
    expect(issueIdFromPath('/privacy')).toBeNull();
    expect(issueIdFromPath(`/issue/${ID}/pdf`)).toBeNull();
  });
});

describe('startIssueActions', () => {
  it('owner: shows «Поделиться» and «Скачать PDF»', async () => {
    backend(() => ready);
    startIssueActions(ID, OPTIONS);
    await flush();
    expect(calls).toEqual([`GET /api/app/issues/${ID}`]);
    expect(lastParams(sdk.mainButton)).toMatchObject({ isVisible: true, text: 'Поделиться' });
    expect(lastParams(sdk.secondaryButton)).toMatchObject({
      isVisible: true,
      text: 'Скачать PDF',
    });
  });

  it.each([
    ['404 (foreign or deleted)', [404, { error: 'not_found' }]],
    [
      'not ready',
      [200, { issue: { id: ID, status: 'composing', progress: null, error: null, number: null } }],
    ],
  ] as const)('%s: no buttons', async (_, response) => {
    backend(() => response as [number, unknown]);
    startIssueActions(ID, OPTIONS);
    await flush();
    expect(sdk.mainButton.setParams.ifAvailable).not.toHaveBeenCalled();
    expect(sdk.secondaryButton.setParams.ifAvailable).not.toHaveBeenCalled();
    expect(sdk.mainButton.listeners.size).toBe(0);
  });

  it('share: POST share → shareMessage(preparedMessageId)', async () => {
    backend((method) => (method === 'POST' ? [200, { preparedMessageId: 'pm-1' }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.mainButton.click();
    await flush();
    expect(calls.at(-1)).toBe(`POST /api/app/issues/${ID}/share`);
    expect(sdk.shareMessage).toHaveBeenCalledWith('pm-1');
    expect(sdk.popup.show).not.toHaveBeenCalled();
    expect(lastParams(sdk.mainButton)).toMatchObject({ isLoaderVisible: false, isEnabled: true });
  });

  it('share: user cancel is silent', async () => {
    backend((method) => (method === 'POST' ? [200, { preparedMessageId: 'pm-1' }] : ready));
    sdk.shareMessage.mockRejectedValueOnce(new sdk.ShareMessageError('USER_DECLINED'));
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.mainButton.click();
    await flush();
    expect(sdk.popup.show).not.toHaveBeenCalled();
  });

  it('share: API error → popup with Russian text', async () => {
    backend((method) => (method === 'POST' ? [500, { error: 'misconfigured' }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.mainButton.click();
    await flush();
    expect(sdk.shareMessage).not.toHaveBeenCalled();
    expect(sdk.popup.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/[а-яё]/i) }),
    );
  });

  it('share fallback without shareMessage: t.me/share/url with the startapp link, no API', async () => {
    backend(() => ready);
    sdk.shareMessage.isAvailable.mockReturnValue(false);
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.mainButton.click();
    await flush();
    expect(calls).toHaveLength(1);
    const url = sdk.openTelegramLink.ifAvailable.mock.calls[0]?.[0] as string;
    expect(url.startsWith('https://t.me/share/url?url=')).toBe(true);
    expect(new URL(url).searchParams.get('url')).toBe(
      `https://t.me/podpiska_news_bot?startapp=issue_${ID}`,
    );
  });

  it('share fallback without a bot username shares the public issue URL', async () => {
    backend(() => ready);
    sdk.shareMessage.isAvailable.mockReturnValue(false);
    startIssueActions(ID, { ...OPTIONS, botUsername: null });
    await flush();
    sdk.mainButton.click();
    await flush();
    const url = new URL(sdk.openTelegramLink.ifAvailable.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('url')).toBe(`https://podpiska-news.vercel.app/issue/${ID}`);
  });

  it('PDF: POST pdf-link → downloadFile(url, fileName); cancel silent', async () => {
    const link = { url: 'https://x.example/api/issues/a/pdf?sig=1', fileName: 'Podpiska-7.pdf' };
    backend((method) => (method === 'POST' ? [200, link] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.downloadFile.mockRejectedValueOnce(new sdk.AccessDeniedError('denied'));
    sdk.secondaryButton.click();
    await flush();
    expect(calls.at(-1)).toBe(`POST /api/app/issues/${ID}/pdf-link`);
    expect(sdk.downloadFile).toHaveBeenCalledWith(link.url, link.fileName);
    expect(sdk.popup.show).not.toHaveBeenCalled();
  });

  it('PDF fallback without downloadFile: openLink(url)', async () => {
    const link = { url: 'https://x.example/api/issues/a/pdf?sig=1', fileName: 'Podpiska-7.pdf' };
    backend((method) => (method === 'POST' ? [200, link] : ready));
    sdk.downloadFile.isAvailable.mockReturnValue(false);
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.secondaryButton.click();
    await flush();
    expect(sdk.downloadFile).not.toHaveBeenCalled();
    expect(sdk.openLink.ifAvailable).toHaveBeenCalledWith(link.url);
  });

  it('PDF failure → popup', async () => {
    const link = { url: 'https://x.example/api/issues/a/pdf?sig=1', fileName: 'Podpiska-7.pdf' };
    backend((method) => (method === 'POST' ? [200, link] : ready));
    sdk.downloadFile.mockRejectedValueOnce(new Error('boom'));
    startIssueActions(ID, OPTIONS);
    await flush();
    sdk.secondaryButton.click();
    await flush();
    expect(sdk.popup.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Не удалось скачать PDF. Попробуйте ещё раз.' }),
    );
  });

  it('cleanup hides both buttons and removes handlers', async () => {
    backend(() => ready);
    const stop = startIssueActions(ID, OPTIONS);
    await flush();
    stop();
    expect(sdk.mainButton.listeners.size).toBe(0);
    expect(sdk.secondaryButton.listeners.size).toBe(0);
    expect(lastParams(sdk.mainButton)).toMatchObject({ isVisible: false });
    expect(lastParams(sdk.secondaryButton)).toMatchObject({ isVisible: false });
  });

  it('cleanup before the issue loads: buttons never appear', async () => {
    backend(() => ready);
    const stop = startIssueActions(ID, OPTIONS);
    stop();
    await flush();
    expect(sdk.mainButton.listeners.size).toBe(0);
    expect(lastParams(sdk.mainButton)).toMatchObject({ isVisible: false });
  });
});
