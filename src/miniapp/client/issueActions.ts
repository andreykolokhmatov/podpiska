import {
  AccessDeniedError,
  downloadFile,
  openLink,
  openTelegramLink,
  popup,
  shareMessage,
  ShareMessageError,
} from '@tma.js/sdk-react';

import {
  issueResponseSchema,
  pdfLinkResponseSchema,
  shareIssueResponseSchema,
} from '@/miniapp/contract';
import { issueStartUrl } from '@/miniapp/share';

import { apiFetch } from './api';
import { haptic } from './sdk';
import { errorText, t } from './texts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The issue id of a newspaper path (`/issue/<uuid>`); null for /issue/preview, /privacy, … */
export function issueIdFromPath(pathname: string): string | null {
  const match = /^\/issue\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
  return id !== null && UUID.test(id) ? id : null;
}

/** Shows the owner's action trigger on the page; returns how to set it busy and remove it. */
export type MountTrigger = (onClick: () => void) => {
  setBusy: (busy: boolean) => void;
  remove: () => void;
};

export interface IssueActionsOptions {
  /** From the newspaper's promo plate; null when the deploy has no TELEGRAM_BOT_USERNAME. */
  botUsername: string | null;
  /** Public origin of the newspaper, for the fallback share link. */
  origin: string;
  mountTrigger: MountTrigger;
}

async function showError(message: string): Promise<void> {
  haptic.error();
  if (popup.show.isAvailable()) {
    try {
      await popup.show({ title: t.issueActions.errorTitle, message, buttons: [{ type: 'ok' }] });
      return;
    } catch {
      // Another popup is open: fall through to the plain alert.
    }
  }
  window.alert(message);
}

/** The user closed the native dialog: not an error, nothing to say. */
const isCancel = (error: unknown): boolean =>
  error instanceof AccessDeniedError ||
  (error instanceof ShareMessageError && error.message === 'USER_DECLINED');

type Action = 'share' | 'pdf';

/** Native action sheet; without popups (old clients) the trigger just shares. */
async function chooseAction(number: number | null): Promise<Action | null> {
  if (!popup.show.isAvailable()) return 'share';
  const id = await popup.show({
    title: number === null ? t.issueActions.menuTitleBare : t.issueTitle(number),
    message: t.issueActions.menuText,
    buttons: [
      { id: 'share', type: 'default', text: t.issueActions.share },
      { id: 'pdf', type: 'default', text: t.issueActions.pdf },
      { type: 'cancel' },
    ],
  });
  return id === 'share' || id === 'pdf' ? id : null;
}

/**
 * Owner actions on the newspaper inside the Mini App: one quiet round trigger (not the bottom
 * bar, which covered the paper) opening a native popup with «Поделиться» / «Скачать PDF». The
 * issue endpoint answers 200 only for the owner's own ready issue, so anyone else gets nothing.
 * Returns a cleanup.
 */
export function startIssueActions(issueId: string, options: IssueActionsOptions): () => void {
  let alive = true;
  let busy = false;
  let trigger: ReturnType<MountTrigger> | undefined;
  const path = `/api/app/issues/${encodeURIComponent(issueId)}`;
  const share = async (number: number | null) => {
    if (!shareMessage.isAvailable()) {
      const link = options.botUsername
        ? issueStartUrl(options.botUsername, issueId)
        : `${options.origin}/issue/${issueId}`;
      const text = number === null ? '' : t.issueTitle(number);
      openTelegramLink.ifAvailable(
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
      );
      return;
    }
    const res = await apiFetch(`${path}/share`, shareIssueResponseSchema, { method: 'POST' });
    if (!alive) return;
    if (!res.ok) return showError(errorText(res.error.error));
    try {
      await shareMessage(res.data.preparedMessageId);
      haptic.success();
    } catch (error) {
      if (!isCancel(error)) await showError(t.issueActions.shareFailed);
    }
  };

  const download = async () => {
    const res = await apiFetch(`${path}/pdf-link`, pdfLinkResponseSchema, { method: 'POST' });
    if (!alive) return;
    if (!res.ok) return showError(errorText(res.error.error));
    if (!downloadFile.isAvailable()) {
      openLink.ifAvailable(res.data.url);
      return;
    }
    try {
      await downloadFile(res.data.url, res.data.fileName);
      haptic.success();
    } catch (error) {
      if (!isCancel(error)) await showError(t.issueActions.pdfFailed);
    }
  };

  const onTrigger = async (number: number | null) => {
    if (busy) return;
    busy = true;
    haptic.selection();
    try {
      const action = await chooseAction(number);
      if (action === null || !alive) return;
      haptic.impact();
      trigger?.setBusy(true);
      await (action === 'share' ? share(number) : download());
    } finally {
      busy = false;
      if (alive) trigger?.setBusy(false);
    }
  };

  void apiFetch(path, issueResponseSchema).then((res) => {
    if (!alive || !res.ok || res.data.issue.status !== 'ready') return;
    const number = res.data.issue.number;
    trigger = options.mountTrigger(() => void onTrigger(number));
  });

  return () => {
    alive = false;
    trigger?.remove();
    trigger = undefined;
  };
}
