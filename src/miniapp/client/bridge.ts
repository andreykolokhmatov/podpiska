import {
  backButton,
  init,
  isTMA,
  mainButton,
  miniApp,
  openTelegramLink,
  postEvent,
  secondaryButton,
} from '@tma.js/sdk-react';

/** Opened by a full page load, so history.back() returns to the Mini App screen we came from. */
function goBack(): void {
  if (window.history.length > 1) window.history.back();
  // Full load on purpose: the newspaper and the (app) tree use different stylesheets.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  else window.location.assign('/');
}

const POST_LINK = '.np a[href^="https://t.me/"]';

/**
 * Telegram keeps the hub's MainButton across the full page load, so the newspaper would show an
 * empty bar. Hide it through the SDK (updates the state it persists for the hub's next mount) and
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
 * Newspaper / privacy inside Telegram: native BackButton and t.me links through
 * openTelegramLink (a plain target=_blank link would leave the Mini App). Returns a cleanup.
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

  return () => {
    document.removeEventListener('click', onClick);
    if (off.ok) off.data();
    backButton.hide.ifAvailable();
  };
}
