import {
  backButton,
  init,
  isTMA,
  mainButton,
  miniApp,
  openTelegramLink,
  postEvent,
  retrieveRawInitData,
  secondaryButton,
} from '@tma.js/sdk-react';

import { configureApi, type FetchLike } from './api';
import { loadDevMock, wantsDevMock } from './devMock';
import { issueIdFromPath, startIssueActions, type MountTrigger } from './issueActions';
import { t } from './texts';

/** Opened by a full page load, so history.back() returns to the Mini App screen we came from. */
function goBack(): void {
  if (window.history.length > 1) window.history.back();
  // Full load on purpose: the newspaper and the (app) tree use different stylesheets.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  else window.location.assign('/');
}

const POST_LINK ='.np a[href^="https://t.me/"]';

/** The promo plate carries the bot username (server env), so the share fallback can deep-link. */
function promoBot(): string | null {
  const plate = document.querySelector<HTMLElement>('.np [data-promo-bot]');
  return plate?.dataset.promoBot ?? null;
}

async function apiTransport(): Promise<FetchLike | undefined> {
  if (!loadDevMock || !wantsDevMock(window.location.search)) return undefined;
  return (await loadDevMock()).installDevMock(window.location.search);
}

const SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>';

/** Round ink button in the newspaper's corner; styled by .np-fab in newspaper.css. */
const mountShareFab: MountTrigger = (onClick) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'np-fab';
  button.setAttribute('aria-label', t.issueActions.trigger);
  button.innerHTML = SHARE_ICON;
  button.addEventListener('click', onClick);
  (document.querySelector('.np') ?? document.body).append(button);
  return {
    setBusy: (busy) => {
      button.disabled = busy;
      button.classList.toggle('np-fab--busy', busy);
    },
    remove: () => button.remove(),
  };
};

/**
 * Telegram keeps the hub's MainButton across the full page load, so the newspaper would show an
 * empty bar. Start from hidden; the owner's own issue then gets its share/PDF buttons. Hide it through the SDK (updates the state it persists for the hub's next mount) and
 * with a raw event (the SDK skips posting when its restored state already says hidden).
 */
function hideBottomButtons(): void {
  mainButton.mount.ifAvailable();
  mainButton.setParams.ifAvailable({
    isVisible: false,
    isLoaderVisible: false,
    hasShineEffect: false,
  });
  secondaryButton.mount.ifAvailable();
  secondaryButton.setParams.ifAvailable({ isVisible: false });
  for (const method of ['web_app_setup_main_button', 'web_app_setup_secondary_button'] as const) {
    try {
      postEvent(method, { is_visible: false });
    } catch {
      // Older clients without a secondary button.
    }
  }
}

/**
 * Newspaper / privacy inside Telegram: native BackButton, t.me links through openTelegramLink
 * (a plain target=_blank link would leave the Mini App) and, on an issue, the owner's share/PDF
 * buttons. Returns a cleanup.
 */
export function startBridge(): (() => void) | undefined {
  if (!isTMA()) return undefined;
  init();
  miniApp.mount.ifAvailable();
  miniApp.ready.ifAvailable();
  hideBottomButtons();
  backButton.mount.ifAvailable();
  backButton.show.ifAvailable();
  const off = backButton.onClick.ifAvailable(goBack);

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target.closest(POST_LINK) : null;
    if (!(target instanceof HTMLAnchorElement) || !openTelegramLink.isAvailable()) return;
    event.preventDefault();
    openTelegramLink(target.href);
  };
  document.addEventListener('click', onClick);

  let alive = true;
  let stopActions: (() => void) | undefined;
  const issueId = issueIdFromPath(window.location.pathname);
  if (issueId !== null) {
    void apiTransport()
      .catch(() => undefined)
      .then((transport) => {
        if (!alive) return;
        configureApi({
          initDataRaw: retrieveRawInitData(),
          ...(transport ? { fetch: transport } : {}),
        });
        stopActions = startIssueActions(issueId, {
          botUsername: promoBot(),
          origin: window.location.origin,
          mountTrigger: mountShareFab,
        });
      });
  }

  return () => {
    alive = false;
    stopActions?.();
    document.removeEventListener('click', onClick);
    if (off.ok) off.data();
    backButton.hide.ifAvailable();
  };
}
