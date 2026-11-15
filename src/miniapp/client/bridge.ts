import { backButton, init, isTMA, miniApp, openTelegramLink } from '@tma.js/sdk-react';

/** Opened by a full page load, so history.back() returns to the Mini App screen we came from. */
function goBack(): void {
  if (window.history.length > 1) window.history.back();
  // Full load on purpose: the newspaper and the (app) tree use different stylesheets.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  else window.location.assign('/');
}

const POST_LINK = '.np a[href^="https://t.me/"]';

/**
 * Newspaper / privacy inside Telegram: native BackButton and t.me links through
 * openTelegramLink (a plain target=_blank link would leave the Mini App). Returns a cleanup.
 */
export function startBridge(): (() => void) | undefined {
  if (!isTMA()) return undefined;
  init();
  miniApp.mount.ifAvailable();
  miniApp.ready.ifAvailable();
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
