import { Bot, type BotError, GrammyError, InlineKeyboard } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { AddChannelError, type AddChannelFailure, type AddChannelResult } from '@/channels';

import { extractChannelCandidate, type ChannelInputError } from './channel-input';
import type { BotStore } from './store';
import { texts } from './texts';

export interface BotDeps {
  token: string;
  /** Pre-fetched getMe result (tests); without it grammY calls getMe on init. */
  botInfo?: UserFromGetMe;
  store: BotStore;
  addChannel: (userId: number, username: string, limit: number) => Promise<AddChannelResult>;
  appUrl: string;
  maxChannels: number;
  log: (line: string) => void;
}

const inputErrorText: Record<ChannelInputError, string> = {
  private: texts.private,
  not_channel_forward: texts.notChannel,
  addlist: texts.addlist,
};

const addErrorText: Record<AddChannelFailure, string> = {
  private: texts.private,
  not_found: texts.notFound,
  invalid: texts.invalid,
  retry_later: texts.retryLater,
};

const MEDIA_GROUPS_KEPT = 500;

/** Remembers recent album ids so an album gets one reply, not one per photo. */
function createMediaGroupFilter(): (id: string) => boolean {
  const seen = new Set<string>();
  return (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > MEDIA_GROUPS_KEPT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}

const updateType = (update: Update): string =>
  Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo === undefined ? {} : { botInfo: deps.botInfo });
  const openApp = () => new InlineKeyboard().webApp(texts.openApp, deps.appUrl);
  const firstOfAlbum = createMediaGroupFilter();

  // Only metadata is logged: update text and tokens must never reach the logs.
  const logError = (err: BotError): void => {
    const { error } = err;
    const name = error instanceof Error ? error.name : typeof error;
    const code = error instanceof GrammyError ? ` code=${error.error_code}` : '';
    deps.log(
      `bot error: update_id=${err.ctx.update.update_id} type=${updateType(err.ctx.update)} error=${name}${code}`,
    );
  };
  const replyFailure = async (err: BotError): Promise<void> => {
    logError(err);
    const { chat } = err.ctx;
    if (chat?.type !== 'private') return;
    try {
      await err.ctx.api.sendMessage(chat.id, texts.failure);
    } catch {
      // Best effort: the original error is already logged; nothing more to tell the user.
    }
  };
  // bot.catch only covers polling; the boundary keeps handleUpdate (webhook) from rejecting.
  bot.catch(logError);
  const chat = bot.errorBoundary(replyFailure).chatType('private');

  chat.command('start', async (ctx) => {
    await deps.store.upsertUser(ctx.from);
    await ctx.reply(texts.welcome, { reply_markup: openApp() });
  });

  chat.on('message', async (ctx) => {
    const groupId = ctx.message.media_group_id;
    if (groupId !== undefined && !firstOfAlbum(groupId)) return;

    const user = await deps.store.upsertUser(ctx.from);
    const candidate = extractChannelCandidate(ctx.message);
    if (candidate === null) {
      await ctx.reply(texts.welcome, { reply_markup: openApp() });
      return;
    }
    if (candidate.kind === 'error') {
      await ctx.reply(inputErrorText[candidate.reason]);
      return;
    }

    let result: AddChannelResult;
    try {
      result = await deps.addChannel(user.id, candidate.username, deps.maxChannels);
    } catch (error) {
      if (!(error instanceof AddChannelError)) throw error;
      await ctx.reply(addErrorText[error.reason]);
      return;
    }
    const { status, channel } = result;
    if (status === 'limit') {
      await ctx.reply(texts.limit(deps.maxChannels));
      return;
    }
    const text = status === 'added' ? texts.added : texts.exists;
    await ctx.reply(text(channel.username, channel.title), { reply_markup: openApp() });
  });

  return bot;
}
