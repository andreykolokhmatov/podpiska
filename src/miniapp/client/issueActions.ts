import {
  AccessDeniedError,
  downloadFile,
  mainButton,
  openLink,
  openTelegramLink,
  popup,
  secondaryButton,
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

export interface IssueActionsOptions {
  /** From the newspaper's promo plate; null when the deploy has no TELEGRAM_BOT_USERNAME. */
  botUsername: string | null;
  /** Public origin of the newspaper, for the fallback share link. */
  origin: string;
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

/**
 * Owner actions on the newspaper inside the Mini App: MainButton «Поделиться» and
 * SecondaryButton «Скачать PDF». The issue endpoint answers 200 only for the owner's own ready
 * issue, so anyone else (or a deleted issue) gets no buttons. Returns a cleanup.
 */
export function startIssueActions(issueId: string, options: IssueActionsOptions): () => void {
  let alive = true;
  let busy = false;
  const offs: (() => void)[] = [];
  const path = `/api/app/issues/${encodeURIComponent(issueId)}`;

  const run = async (
    button: typeof mainButton | typeof secondaryButton,
    action: () => Promise<void>,
  ) => {
    if (busy) return;
    busy = true;
    haptic.impact();
    button.setParams.ifAvailable({ isLoaderVisible: true, isEnabled: false });
    try {
      await action();
    } finally {
      busy = false;
      if (alive) button.setParams.ifAvailable({ isLoaderVisible: false, isEnabled: true });
    }
  };

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

  void apiFetch(path, issueResponseSchema).then((res) => {
    if (!alive || !res.ok || res.data.issue.status !== 'ready') return;
    const number = res.data.issue.number;

    mainButton.setParams.ifAvailable({
      isVisible: true,
      isEnabled: true,
      isLoaderVisible: false,
      hasShineEffect: false,
      text: t.issueActions.share,
    });
    secondaryButton.setParams.ifAvailable({
      isVisible: true,
      isEnabled: true,
      isLoaderVisible: false,
      hasShineEffect: false,
      position: 'left',
      text: t.issueActions.pdf,
    });
    for (const off of [
      mainButton.onClick.ifAvailable(() => void run(mainButton, () => share(number))),
      secondaryButton.onClick.ifAvailable(() => void run(secondaryButton, download)),
    ]) {
      if (off.ok) offs.push(off.data);
    }
  });

  return () => {
    alive = false;
    for (const off of offs.splice(0)) off();
    mainButton.setParams.ifAvailable({ isVisible: false, isLoaderVisible: false });
    secondaryButton.setParams.ifAvailable({ isVisible: false, isLoaderVisible: false });
  };
}
