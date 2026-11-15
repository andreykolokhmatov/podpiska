import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';

import { createWebhookHandler, verifySecretToken } from './webhook';

const SECRET = 'webhook_secret-123';
const update: Update = { update_id: 99 } as Update;

const request = (headers: Record<string, string>, body: unknown = update) =>
  new Request('https://podpiska.example.com/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const setup = (handleUpdate: (u: Update) => Promise<void> = async () => undefined) => {
  const bot = new Bot('42:TEST', { botInfo: { id: 42, is_bot: true } as UserFromGetMe });
  const spy = vi.spyOn(bot, 'handleUpdate').mockImplementation(handleUpdate);
  const getBot = vi.fn(async () => bot);
  const lines: string[] = [];
  const handler = createWebhookHandler({ secret: SECRET, getBot, log: (l) => lines.push(l) });
  return { handler, getBot, spy, lines };
};

describe('verifySecretToken', () => {
  it('accepts only the exact secret', () => {
    expect(verifySecretToken(SECRET, SECRET)).toBe(true);
    expect(verifySecretToken(`${SECRET}x`, SECRET)).toBe(false);
    expect(verifySecretToken('', SECRET)).toBe(false);
    expect(verifySecretToken(null, SECRET)).toBe(false);
  });
});

describe('createWebhookHandler', () => {
  it.each([{}, { 'x-telegram-bot-api-secret-token': 'wrong' }])(
    'returns 401 without initialising the bot (%o)',
    async (headers) => {
      const { handler, getBot, spy } = setup();
      const response = await handler(request(headers));
      expect(response.status).toBe(401);
      expect(getBot).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('passes the update to the bot with the right secret', async () => {
    const { handler, spy, getBot } = setup();
    const headers = { 'x-telegram-bot-api-secret-token': SECRET };
    expect((await handler(request(headers))).status).toBe(200);
    expect((await handler(request(headers))).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toEqual(update);
    expect(getBot).toHaveBeenCalledTimes(1);
  });

  it('answers 200 when handling fails and logs no details', async () => {
    const { handler, lines } = setup(async () => {
      throw new Error('boom SECRET-DETAIL');
    });
    const response = await handler(request({ 'x-telegram-bot-api-secret-token': SECRET }));
    expect(response.status).toBe(200);
    expect(lines).toEqual(['webhook error: Error']);
  });

  it('answers 200 when the bot cannot be created', async () => {
    const lines: string[] = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      getBot: async () => {
        throw new Error('env missing');
      },
      log: (l) => lines.push(l),
    });
    const response = await handler(request({ 'x-telegram-bot-api-secret-token': SECRET }));
    expect(response.status).toBe(200);
    expect(lines).toHaveLength(1);
  });
});
