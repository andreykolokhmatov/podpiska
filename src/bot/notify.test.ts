import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { createIssueNotifier, issueReadyMessage, type NotifierDeps } from './notify';

const APP_URL = 'https://podpiska.example.com';
const notice = { issueId: '0b1c2d3e-0000-4000-8000-000000000001', userId: 7, number: 4 };

const apiError = (code: number, retryAfter?: number, description = `error ${code}`) =>
  new GrammyError(
    'call failed',
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
    },
    'sendMessage',
    {},
  );

const setup = (send: () => Promise<unknown> = async () => ({})) => {
  const claimed = new Set<string>();
  const store = {
    claimNotify: vi.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
    releaseNotify: vi.fn(async (id: string) => {
      claimed.delete(id);
    }),
    telegramIdOf: vi.fn(async () => 1001),
    markBlocked: vi.fn(async () => undefined),
  };
  const sendMessage = vi.fn(send);
  const sleep = vi.fn(async () => undefined);
  const notify = createIssueNotifier({
    api: { sendMessage } as unknown as NotifierDeps['api'],
    appUrl: APP_URL,
    store,
    sleep,
  });
  return { notify, store, sendMessage, sleep, claimed };
};

describe('issueReadyMessage', () => {
  it('links the issue page through a web_app button', () => {
    const { text, reply_markup } = issueReadyMessage(APP_URL, notice);
    expect(text).toBe('📰 Выпуск № 4 готов');
    expect(reply_markup.inline_keyboard[0]?.[0]).toMatchObject({
      web_app: { url: `${APP_URL}/issue/${notice.issueId}` },
    });
  });
});

describe('createIssueNotifier', () => {
  it('sends once per issue', async () => {
    const { notify, sendMessage } = setup();
    await expect(notify(notice)).resolves.toBe('sent');
    await expect(notify(notice)).resolves.toBe('skipped');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]).toEqual([
      1001,
      '📰 Выпуск № 4 готов',
      expect.objectContaining({ reply_markup: expect.anything() }),
    ]);
  });

  it('marks the user blocked on 403 "blocked by the user" and does not throw', async () => {
    const { notify, store, claimed } = setup(async () => {
      throw apiError(403, undefined, 'Forbidden: bot was blocked by the user');
    });
    await expect(notify(notice)).resolves.toBe('blocked');
    expect(store.markBlocked).toHaveBeenCalledWith(7);
    expect(store.releaseNotify).not.toHaveBeenCalled();
    expect(claimed.has(notice.issueId)).toBe(true);
  });

  it('does not mark blocked when the bot cannot initiate the conversation', async () => {
    const { notify, store, claimed } = setup(async () => {
      throw apiError(403, undefined, "Forbidden: bot can't initiate conversation with a user");
    });
    await expect(notify(notice)).resolves.toBe('unreachable');
    expect(store.markBlocked).not.toHaveBeenCalled();
    expect(store.releaseNotify).not.toHaveBeenCalled();
    expect(claimed.has(notice.issueId)).toBe(true);
  });

  it('waits retry_after once on 429', async () => {
    let calls = 0;
    const { notify, sendMessage, sleep } = setup(async () => {
      calls += 1;
      if (calls === 1) throw apiError(429, 3);
      return {};
    });
    await expect(notify(notice)).resolves.toBe('sent');
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not wait for a long retry_after; releases the claim', async () => {
    const { notify, sleep, store } = setup(async () => {
      throw apiError(429, 60);
    });
    await expect(notify(notice)).rejects.toBeInstanceOf(GrammyError);
    expect(sleep).not.toHaveBeenCalled();
    expect(store.releaseNotify).toHaveBeenCalledWith(notice.issueId);
  });

  it('releases the claim and rethrows a transient error', async () => {
    let fail = true;
    const { notify, store, sendMessage } = setup(async () => {
      if (fail) throw new Error('network down');
      return {};
    });
    await expect(notify(notice)).rejects.toThrow('network down');
    expect(store.releaseNotify).toHaveBeenCalledWith(notice.issueId);
    fail = false;
    await expect(notify(notice)).resolves.toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('skips a user who blocked the bot', async () => {
    const { notify, store, sendMessage } = setup();
    store.telegramIdOf.mockResolvedValueOnce(undefined as never);
    await expect(notify(notice)).resolves.toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
