'use client';

import { useEffect } from 'react';

import { LAUNCH_PARAMS_KEY, looksLikeTma } from './env';

function storedLaunchParams(): string | null {
  try {
    return window.sessionStorage.getItem(LAUNCH_PARAMS_KEY);
  } catch {
    return null;
  }
}

/**
 * Renders nothing. Inside Telegram it loads the SDK (a separate chunk, so a plain browser never
 * downloads it) and wires BackButton + post links; outside it does nothing at all.
 */
export function MiniAppBridge() {
  useEffect(() => {
    if (!looksLikeTma(window.location, storedLaunchParams())) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import('@/miniapp/client/bridge')
      .then(({ startBridge }) => {
        if (!cancelled) cleanup = startBridge();
      })
      .catch(() => {
        // No bridge: the page still works as a plain web page.
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return null;
}
