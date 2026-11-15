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

/** «Мы приостановили газету» with a web_app button straight to the schedule screen. */
export function schedulePausedMessage(appUrl: string): {
  text: string;
  reply_markup: InlineKeyboard;
} {
  return {
    text: texts.schedulePaused,
    // web_app, not a callback: the webhook only receives messages (allowed_updates).
    reply_markup: new InlineKeyboard().webApp(texts.openSchedule, `${appUrl}/schedule`),
  };
}

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

type Message = { text: string; reply_markup: InlineKeyboard };

/** One retry on a short 429; any other error is thrown. */
async function sendWithRetry(
  deps: Pick<NotifierDeps, 'api' | 'sleep'>,
  chatId: number,
  { text, reply_markup }: Message,
): Promise<void> {
  try {
    await deps.api.sendMessage(chatId, text, { reply_markup });
  } catch (error) {
    const retryAfter =
      error instanceof GrammyError && error.error_code === 429
        ? error.parameters.retry_after
        : undefined;
    if (retryAfter === undefined || retryAfter > MAX_RETRY_AFTER_S) throw error;
    await (deps.sleep ?? defaultSleep)(retryAfter * 1000);
    await deps.api.sendMessage(chatId, text, { reply_markup });
  }
}

/** blocked/unreachable for a 403 (marking a block); undefined for anything else. */
async function forbidden(
  deps: { store: Pick<BotStore, 'markBlocked'> },
  userId: number,
  error: unknown,
): Promise<'blocked' | 'unreachable' | undefined> {
  if (!(error instanceof GrammyError) || error.error_code !== 403) return undefined;
  if (!BLOCKED_403.test(error.description)) return 'unreachable';
  await deps.store.markBlocked(userId);
  return 'blocked';
}

/** Sends "issue ready" at most once per issue (claim via issues.notified_at). */
export function createIssueNotifier(
  deps: NotifierDeps,
): (notice: IssueReadyNotice) => Promise<NotifyOutcome> {
  return async (notice) => {
    if (!(await deps.store.claimNotify(notice.issueId))) return 'skipped';
    try {
      const chatId = await deps.store.telegramIdOf(notice.userId);
      // Unknown or blocked user: keep the claim, a later retry would not reach them either.
      if (chatId === undefined) return 'skipped';
      await sendWithRetry(deps, chatId, issueReadyMessage(deps.appUrl, notice));
      return 'sent';
    } catch (error) {
      // On a 403 the claim stays: retrying is pointless until the user sends /start.
      const outcome = await forbidden(deps, notice.userId, error);
      if (outcome !== undefined) return outcome;
      await deps.store.releaseNotify(notice.issueId);
      throw error;
    }
  };
}

/**
 * Tells the user their schedule was paused. Sent once by the caller (guarded by the pause
 * update); a non-403 failure is thrown.
 */
export async function sendSchedulePaused(
  deps: Pick<NotifierDeps, 'api' | 'appUrl' | 'sleep'> & {
    store: Pick<BotStore, 'telegramIdOf' | 'markBlocked'>;
  },
  userId: number,
): Promise<NotifyOutcome> {
  try {
    const chatId = await deps.store.telegramIdOf(userId);
    if (chatId === undefined) return 'skipped';
    await sendWithRetry(deps, chatId, schedulePausedMessage(deps.appUrl));
    return 'sent';
  } catch (error) {
    const outcome = await forbidden(deps, userId, error);
    if (outcome !== undefined) return outcome;
    throw error;
  }
}
