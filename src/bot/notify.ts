import { type Api, GrammyError, InlineKeyboard } from 'grammy';

import type { BotStore } from './store';
import { texts } from './texts';

export interface IssueReadyNotice {
  issueId: string;
  userId: number;
  number: number;
}

export function issueReadyMessage(
  appUrl: string,
  notice: Pick<IssueReadyNotice, 'issueId' | 'number'>,
): { text: string; reply_markup: InlineKeyboard } {
  const url = `${appUrl}/issue/${encodeURIComponent(notice.issueId)}`;
  return {
    text: texts.issueReady(notice.number),
    reply_markup: new InlineKeyboard().webApp(texts.openIssue, url),
  };
}

export type NotifyOutcome = 'sent' | 'skipped' | 'blocked' | 'unreachable';

export interface NotifierDeps {
  api: Pick<Api, 'sendMessage'>;
  appUrl: string;
  store: Pick<BotStore, 'claimNotify' | 'releaseNotify' | 'telegramIdOf' | 'markBlocked'>;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_S = 10;

// Only these 403s mean the user cut the bot off; "bot can't initiate conversation" just means
// they never pressed Start (e.g. a Mini App user), which must not mark them blocked.
const BLOCKED_403 = /blocked by the user|user is deactivated/i;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends "issue ready" at most once per issue (claim via issues.notified_at). */
export function createIssueNotifier(
  deps: NotifierDeps,
): (notice: IssueReadyNotice) => Promise<NotifyOutcome> {
  const sleep = deps.sleep ?? defaultSleep;

  const send = async (chatId: number, notice: IssueReadyNotice): Promise<void> => {
    const { text, reply_markup } = issueReadyMessage(deps.appUrl, notice);
    try {
      await deps.api.sendMessage(chatId, text, { reply_markup });
    } catch (error) {
      const retryAfter =
        error instanceof GrammyError && error.error_code === 429
          ? error.parameters.retry_after
          : undefined;
      if (retryAfter === undefined || retryAfter > MAX_RETRY_AFTER_S) throw error;
      await sleep(retryAfter * 1000);
      await deps.api.sendMessage(chatId, text, { reply_markup });
    }
  };

  return async (notice) => {
    if (!(await deps.store.claimNotify(notice.issueId))) return 'skipped';
    try {
      const chatId = await deps.store.telegramIdOf(notice.userId);
      // Unknown or blocked user: keep the claim, a later retry would not reach them either.
      if (chatId === undefined) return 'skipped';
      await send(chatId, notice);
      return 'sent';
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 403) {
        // Either way the claim stays: retrying is pointless until the user sends /start.
        if (!BLOCKED_403.test(error.description)) return 'unreachable';
        await deps.store.markBlocked(notice.userId);
        return 'blocked';
      }
      await deps.store.releaseNotify(notice.issueId);
      throw error;
    }
  };
}
