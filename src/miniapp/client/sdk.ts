import {
  backButton,
  hapticFeedback,
  init,
  initData,
  isTMA,
  mainButton,
  miniApp,
  openLink,
  openTelegramLink,
  popup,
  retrieveLaunchParams,
  retrieveRawInitData,
  themeParams,
  viewport,
} from '@tma.js/sdk-react';

import { configureApi, type FetchLike } from './api';
import { loadDevMock, wantsDevMock } from './devMock';
import { uiPlatform, type UiPlatform } from './env';

export interface TmaUser {
  firstName: string;
  lastName: string | null;
  photoUrl: string | null;
}

export interface TmaEnv {
  platform: UiPlatform;
  user: TmaUser | null;
}

let pending: Promise<TmaEnv | null> | undefined;

/** Initializes the SDK once per document; null = not inside Telegram (no API calls then). */
export function initTmaOnce(): Promise<TmaEnv | null> {
  pending ??= start().catch(() => null);
  return pending;
}

async function start(): Promise<TmaEnv | null> {
  let mockFetch: FetchLike | undefined;
  if (loadDevMock && wantsDevMock(window.location.search)) {
    mockFetch = (await loadDevMock()).installDevMock(window.location.search);
  }
  if (!isTMA()) return null;

  init();
  initData.restore();
  backButton.mount.ifAvailable();
  mainButton.mount.ifAvailable();
  // Start from a known hidden state: the restored one may not match what Telegram shows, and the
  // SDK only posts changes. Each screen then shows its own button.
  mainButton.setParams.ifAvailable({
    isVisible: false,
    isLoaderVisible: false,
    hasShineEffect: false,
  });
  themeParams.mount.ifAvailable();
  themeParams.bindCssVars.ifAvailable();
  miniApp.mount.ifAvailable();
  miniApp.setHeaderColor.ifAvailable('secondary_bg_color');
  miniApp.setBgColor.ifAvailable('secondary_bg_color');
  miniApp.setBottomBarColor.ifAvailable('secondary_bg_color');
  if (viewport.mount.isAvailable()) {
    try {
      await viewport.mount({ timeout: 2_000 });
      viewport.bindCssVars.ifAvailable();
      viewport.expand.ifAvailable();
    } catch {
      // Viewport metrics are cosmetic; the app works without them.
    }
  }
  miniApp.ready.ifAvailable();

  configureApi({ initDataRaw: retrieveRawInitData(), ...(mockFetch ? { fetch: mockFetch } : {}) });
  const user = initData.user();
  return {
    platform: uiPlatform(retrieveLaunchParams().tgWebAppPlatform),
    user: user
      ? {
          firstName: user.first_name,
          lastName: user.last_name ?? null,
          photoUrl: user.photo_url ?? null,
        }
      : null,
  };
}

export const haptic = {
  impact: () => void hapticFeedback.impactOccurred.ifAvailable('medium'),
  selection: () => void hapticFeedback.selectionChanged.ifAvailable(),
  success: () => void hapticFeedback.notificationOccurred.ifAvailable('success'),
  error: () => void hapticFeedback.notificationOccurred.ifAvailable('error'),
};

/** Post links (t.me) open natively in Telegram; anything else in the in-app browser. */
export function openPostLink(url: string): void {
  if (url.startsWith('https://t.me/') && openTelegramLink.isAvailable()) {
    openTelegramLink(url);
  } else if (openLink.isAvailable()) {
    openLink(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export async function confirmDestructive(
  title: string,
  message: string,
  confirmText: string,
): Promise<boolean> {
  if (!popup.show.isAvailable()) return window.confirm(`${title}\n\n${message}`);
  const id = await popup.show({
    title,
    message,
    buttons: [{ id: 'confirm', type: 'destructive', text: confirmText }, { type: 'cancel' }],
  });
  return id === 'confirm';
}

/** Leaving the (app) tree is always a full page load: /issue and /privacy carry their own CSS. */
export function navigateFull(url: string): void {
  window.location.assign(url);
}
