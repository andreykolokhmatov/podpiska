import type { Transformer } from 'grammy';
import type { Message, Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';

import { AddChannelError, type AddChannelResult } from '@/channels';

import { createBot, type BotDeps } from './bot';
import type { BotStore } from './store';
import { texts } from './texts';

const botInfo: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'Подписка',
  username: 'podpiska_dev_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

const APP_URL = 'https://podpiska.example.com';
const from = { id: 1001, is_bot: false, first_name: 'Андрей', username: 'andrey' };

const channel = {
  username: 'toporlive',
  displayUsername: 'toporlive',
  title: 'Топор Live',
  avatarUrl: null,
};

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

const setup = (
  addChannel?: BotDeps['addChannel'],
  store: Partial<BotStore> = {},
  setChannelTgId?: NonNullable<BotDeps['setChannelTgId']>,
  isAllowed: BotDeps['isAllowed'] = () => true,
) => {
  const calls: Call[] = [];
  const fullStore: BotStore = {
    upsertUser: vi.fn(async () => ({ id: 7 })),
    telegramIdOf: vi.fn(async () => undefined),
    claimNotify: vi.fn(async () => true),
    releaseNotify: vi.fn(async () => undefined),
    markBlocked: vi.fn(async () => undefined),
    ...store,
  };
  const add = vi.fn<BotDeps['addChannel']>(
    addChannel ?? (async (): Promise<AddChannelResult> => ({ status: 'added', channel })),
  );
  const lines: string[] = [];
  const bot = createBot({
    token: '42:TEST',
    botInfo,
    store: fullStore,
    addChannel: add,
    isAllowed,
    appUrl: APP_URL,
    maxChannels: 3,
    log: (line) => lines.push(line),
    ...(setChannelTgId ? { setChannelTgId } : {}),
  });
  const record: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  };
  bot.api.config.use(record);
  return { bot, calls, store: fullStore, add, lines };
};

let updateId = 0;
const privateMessage = (message: Partial<Message>): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: from.id, type: 'private', first_name: from.first_name },
      from,
      ...message,
    },
  }) as Update;

const forwardFrom = (
  username: string,
  extra: Partial<Message> = {},
  chatId = -1001754252633,
): Update =>
  privateMessage({
    forward_origin: {
      type: 'channel',
      date: 0,
      message_id: 5,
      chat: { id: chatId, type: 'channel', title: 'Топор', username },
    },
    ...extra,
  });

const replies = (calls: Call[]) => calls.filter((call) => call.method === 'sendMessage');

const webAppUrl = (call: Call | undefined): unknown =>
  (call?.payload.reply_markup as { inline_keyboard: { web_app?: { url: string } }[][] })
    ?.inline_keyboard[0]?.[0]?.web_app?.url;

describe('createBot', () => {
  it('answers /start with the welcome and the Mini App button', async () => {
    const { bot, calls, store } = setup();
    await bot.handleUpdate(
      privateMessage({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }),
    );
    expect(store.upsertUser).toHaveBeenCalledWith(expect.objectContaining({ id: from.id }));
    const [reply, ...rest] = replies(calls);
    expect(rest).toHaveLength(0);
    expect(reply?.payload.text).toBe('📰 Подписка – ваша личная газета из Telegram-каналов.');
    expect(reply?.payload.parse_mode).toBeUndefined();
    expect(webAppUrl(reply)).toBe(APP_URL);
  });

  it('refuses strangers on a private instance: notice only, no user, no channel', async () => {
    const isAllowed = vi.fn(() => false);
    const { bot, calls, store, add } = setup(undefined, {}, undefined, isAllowed);
    await bot.handleUpdate(
      privateMessage({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }),
    );
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(isAllowed).toHaveBeenCalledWith(from.id);
    expect(store.upsertUser).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    const texts_ = replies(calls).map((call) => call.payload.text);
    expect(texts_).toEqual([texts.privateInstance, texts.privateInstance]);
    expect(texts.privateInstance).toContain('частный экземпляр Подписки');
    expect(texts.privateInstance).toContain('https://github.com/andreykolokhmatov/podpiska');
    expect(texts.privateInstance).not.toContain('—');
  });

  it('adds a channel from a forwarded post', async () => {
    const { bot, calls, add } = setup();
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(add).toHaveBeenCalledWith(7, 'toporlive', 3);
    const [reply] = replies(calls);
    expect(reply?.payload.text).toBe('Канал «Топор Live» (@toporlive) добавлен');
    expect(webAppUrl(reply)).toBe(APP_URL);
  });

  it('records the tg id of a forwarded channel after the add', async () => {
    const setTgId = vi.fn(async () => undefined);
    const { bot, calls } = setup(undefined, {}, setTgId);
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(setTgId).toHaveBeenCalledWith('toporlive', 1754252633);
    expect(replies(calls)[0]?.payload.text).toBe('Канал «Топор Live» (@toporlive) добавлен');
  });

  it('skips the tg id when the add hit the limit or the id is not a Bot API channel id', async () => {
    const setTgId = vi.fn(async () => undefined);
    const limited = setup(async () => ({ status: 'limit', channel }), {}, setTgId);
    await limited.bot.handleUpdate(forwardFrom('toporlive'));
    const odd = setup(undefined, {}, setTgId);
    await odd.bot.handleUpdate(forwardFrom('toporlive', {}, -100));
    expect(setTgId).not.toHaveBeenCalled();
  });

  it('still replies when recording the tg id fails', async () => {
    const setTgId = vi.fn(async () => {
      throw new Error('db down');
    });
    const { bot, calls, lines } = setup(undefined, {}, setTgId);
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(replies(calls)[0]?.payload.text).toBe('Канал «Топор Live» (@toporlive) добавлен');
    expect(lines).toEqual(['set tg_id failed: error=Error']);
  });

  it('says when the channel is already subscribed', async () => {
    const { bot, calls } = setup(async () => ({ status: 'exists', channel }));
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(replies(calls)[0]?.payload.text).toBe('Канал «Топор Live» (@toporlive) уже в подписке');
  });

  it('reports the channel limit', async () => {
    const { bot, calls } = setup(async () => ({ status: 'limit', channel }));
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(replies(calls)[0]?.payload.text).toBe(texts.limit(3));
  });

  it('truncates long titles', async () => {
    const title = 'Я'.repeat(300);
    const { bot, calls } = setup(async () => ({ status: 'added', channel: { ...channel, title } }));
    await bot.handleUpdate(forwardFrom('toporlive'));
    const text = String(replies(calls)[0]?.payload.text);
    expect(text).toContain(`«${'Я'.repeat(99)}…»`);
    expect(text.length).toBeLessThan(140);
  });

  it.each([
    ['not_found', texts.notFound],
    ['retry_later', texts.retryLater],
    ['private', texts.private],
  ] as const)('maps AddChannelError %s to its text', async (reason, expected) => {
    const { bot, calls } = setup(async () => {
      throw new AddChannelError(reason);
    });
    await bot.handleUpdate(forwardFrom('toporlive'));
    expect(replies(calls)[0]?.payload.text).toBe(expected);
  });

  it('answers input errors without calling addChannel', async () => {
    const { bot, calls, add } = setup();
    await bot.handleUpdate(
      privateMessage({
        forward_origin: { type: 'hidden_user', date: 0, sender_user_name: 'X' },
        text: 'hi',
      }),
    );
    const url = 'https://t.me/+AbCdEf';
    await bot.handleUpdate(
      privateMessage({ text: url, entities: [{ type: 'url', offset: 0, length: url.length }] }),
    );
    expect(add).not.toHaveBeenCalled();
    expect(replies(calls).map((call) => call.payload.text)).toEqual([
      texts.notChannel,
      texts.private,
    ]);
  });

  it('answers plain text with the welcome and no lookup', async () => {
    const { bot, calls, add } = setup();
    await bot.handleUpdate(privateMessage({ text: 'toporlive' }));
    expect(add).not.toHaveBeenCalled();
    expect(replies(calls)[0]?.payload.text).toBe(texts.welcome);
  });

  it('ignores group messages', async () => {
    const { bot, calls, store } = setup();
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -5, type: 'group', title: 'G' },
        from,
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    } as Update);
    expect(calls).toHaveLength(0);
    expect(store.upsertUser).not.toHaveBeenCalled();
  });

  it('replies once per album', async () => {
    const { bot, calls, add } = setup();
    await bot.handleUpdate(forwardFrom('toporlive', { media_group_id: 'album-1' }));
    await bot.handleUpdate(forwardFrom('toporlive', { media_group_id: 'album-1' }));
    await bot.handleUpdate(forwardFrom('toporlive', { media_group_id: 'album-1' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(replies(calls)).toHaveLength(1);
  });

  it('logs only metadata when the store throws', async () => {
    const { bot, lines } = setup(undefined, {
      upsertUser: vi.fn(async () => {
        throw new Error('db down SECRET');
      }),
    });
    await expect(bot.handleUpdate(privateMessage({ text: 'private text' }))).resolves.toBe(
      undefined,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/update_id=\d+ type=message error=Error/);
    expect(lines[0]).not.toContain('SECRET');
    expect(lines[0]).not.toContain('private text');
  });

  it('sends a generic reply when a handler fails', async () => {
    const { bot, calls } = setup(async () => {
      throw new TypeError('unexpected');
    });
    await bot.handleUpdate(forwardFrom('toporlive'));
    const [reply, ...rest] = replies(calls);
    expect(rest).toHaveLength(0);
    expect(reply?.payload).toMatchObject({
      chat_id: from.id,
      text: 'Что-то пошло не так, попробуйте позже.',
    });
  });

  it('swallows a failure of the generic reply itself', async () => {
    const { bot, lines } = setup(async () => {
      throw new TypeError('unexpected');
    });
    bot.api.config.use(async () => {
      throw new Error('telegram down');
    });
    await expect(bot.handleUpdate(forwardFrom('toporlive'))).resolves.toBe(undefined);
    expect(lines).toHaveLength(1);
  });
});
