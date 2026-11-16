import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  class ShareMessageError extends Error {}
  const feature = <T extends (...args: never[]) => unknown>() =>
    Object.assign(vi.fn<T>(), { isAvailable: vi.fn(() => true), ifAvailable: vi.fn() });
  return {
    AccessDeniedError,
    ShareMessageError,
    shareMessage: feature<(id: string) => Promise<void>>(),
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
import { issueIdFromPath, startIssueActions, type MountTrigger } from './issueActions';

const ID = '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f';
const trigger = {
  onClick: null as (() => void) | null,
  busy: [] as boolean[],
  removed: 0,
  click: () => trigger.onClick?.(),
};
const mountTrigger: MountTrigger = (onClick) => {
  trigger.onClick = onClick;
  return {
    setBusy: (busy) => trigger.busy.push(busy),
    remove: () => {
      trigger.removed += 1;
      trigger.onClick = null;
    },
  };
};
const OPTIONS = {
  botUsername: 'podpiska_news_bot',
  origin: 'https://podpiska-news.vercel.app',
  mountTrigger,
};
/** The native action sheet answers with this button id. */
const choose = (id: string) => sdk.popup.show.mockResolvedValueOnce(id);

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

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(trigger, { onClick: null, busy: [], removed: 0 });
  for (const f of [sdk.shareMessage, sdk.popup.show]) {
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
  it('owner: mounts one trigger that opens a native menu with both actions', async () => {
    backend(() => ready);
    startIssueActions(ID, OPTIONS);
    await flush();
    expect(calls).toEqual([`GET /api/app/issues/${ID}`]);
    expect(trigger.onClick).not.toBeNull();
    choose('cancel-id');
    trigger.click();
    await flush();
    expect(sdk.popup.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Выпуск №\u00A07',
        buttons: [
          { id: 'share', type: 'default', text: 'Поделиться' },
          { id: 'pdf', type: 'default', text: 'PDF в чат' },
          { type: 'cancel' },
        ],
      }),
    );
    expect(sdk.shareMessage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['404 (foreign or deleted)', [404, { error: 'not_found' }]],
    [
      'not ready',
      [200, { issue: { id: ID, status: 'composing', progress: null, error: null, number: null } }],
    ],
  ] as const)('%s: no trigger', async (_, response) => {
    backend(() => response as [number, unknown]);
    startIssueActions(ID, OPTIONS);
    await flush();
    expect(trigger.onClick).toBeNull();
  });

  it('share: POST share → shareMessage(preparedMessageId)', async () => {
    backend((method) => (method === 'POST' ? [200, { preparedMessageId: 'pm-1' }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    choose('share');
    trigger.click();
    await flush();
    expect(calls.at(-1)).toBe(`POST /api/app/issues/${ID}/share`);
    expect(sdk.shareMessage).toHaveBeenCalledWith('pm-1');
    expect(sdk.popup.show).toHaveBeenCalledTimes(1);
    expect(trigger.busy).toEqual([true, false]);
  });

  it('share: user cancel is silent', async () => {
    backend((method) => (method === 'POST' ? [200, { preparedMessageId: 'pm-1' }] : ready));
    sdk.shareMessage.mockRejectedValueOnce(new sdk.ShareMessageError('USER_DECLINED'));
    startIssueActions(ID, OPTIONS);
    await flush();
    choose('share');
    trigger.click();
    await flush();
    expect(sdk.popup.show).toHaveBeenCalledTimes(1);
  });

  it('share: API error → popup with Russian text', async () => {
    backend((method) => (method === 'POST' ? [500, { error: 'misconfigured' }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    choose('share');
    trigger.click();
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
    choose('share');
    trigger.click();
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
    choose('share');
    trigger.click();
    await flush();
    const url = new URL(sdk.openTelegramLink.ifAvailable.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('url')).toBe(`https://podpiska-news.vercel.app/issue/${ID}`);
  });

  it('PDF: POST pdf → the bot sends it to the chat; a popup says so', async () => {
    backend((method) => (method === 'POST' ? [200, { ok: true }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    choose('pdf');
    trigger.click();
    await flush();
    expect(calls.at(-1)).toBe(`POST /api/app/issues/${ID}/pdf`);
    expect(sdk.popup.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'PDF отправлен', message: 'Файл уже в чате с ботом.' }),
    );
  });

  it('PDF when the bot may not write → popup asks to start the bot', async () => {
    backend((method) => (method === 'POST' ? [409, { error: 'cannot_message' }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    choose('pdf');
    trigger.click();
    await flush();
    expect(sdk.popup.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('нажмите «Старт»') }),
    );
  });

  it('PDF failure → popup', async () => {
    backend((method) => (method === 'POST' ? [500, { error: 'internal' }] : ready));
    startIssueActions(ID, OPTIONS);
    await flush();
    choose('pdf');
    trigger.click();
    await flush();
    expect(sdk.popup.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Не удалось отправить PDF. Попробуйте ещё раз.' }),
    );
  });

  it('cleanup removes the trigger', async () => {
    backend(() => ready);
    const stop = startIssueActions(ID, OPTIONS);
    await flush();
    stop();
    expect(trigger.removed).toBe(1);
    expect(trigger.onClick).toBeNull();
  });

  it('cleanup before the issue loads: the trigger never appears', async () => {
    backend(() => ready);
    const stop = startIssueActions(ID, OPTIONS);
    stop();
    await flush();
    expect(trigger.onClick).toBeNull();
  });
});
