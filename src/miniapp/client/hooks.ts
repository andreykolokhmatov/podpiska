'use client';

import { backButton, mainButton, themeParams, useSignal } from '@tma.js/sdk-react';
import { useRouter } from 'next/navigation';
import { createContext, use, useEffect, useEffectEvent } from 'react';

import type { MainButtonView } from './build';
import type { Appearance } from './env';
import type { TmaEnv } from './sdk';

export const TmaContext = createContext<TmaEnv | null>(null);

export function useTma(): TmaEnv {
  const env = use(TmaContext);
  if (!env) throw new Error('useTma outside TmaRoot');
  return env;
}

export function useAppearance(): Appearance {
  return useSignal(themeParams.isDark) ? 'dark' : 'light';
}

/** Native BackButton while mounted; null hides it (hub, onboarding). */
export function useBackButton(onBack: (() => void) | null): void {
  const visible = onBack !== null;
  const handle = useEffectEvent(() => onBack?.());
  useEffect(() => {
    if (!visible) {
      backButton.hide.ifAvailable();
      return;
    }
    backButton.show.ifAvailable();
    const off = backButton.onClick.ifAvailable(() => handle());
    return () => {
      if (off.ok) off.data();
      backButton.hide.ifAvailable();
    };
  }, [visible]);
}

/** Native MainButton for the screen; null hides it. */
export function useMainButton(view: MainButtonView | null, onClick: () => void): void {
  const handle = useEffectEvent(onClick);
  const visible = view !== null;
  const text = view?.text ?? '';
  const enabled = view?.enabled ?? false;
  const loader = view?.loader ?? false;
  const shine = view?.shine ?? false;

  useEffect(() => {
    if (!visible) {
      mainButton.setParams.ifAvailable({ isVisible: false });
      return;
    }
    mainButton.setParams.ifAvailable({
      isVisible: true,
      text,
      isEnabled: enabled,
      isLoaderVisible: loader,
      hasShineEffect: shine,
    });
  }, [visible, text, enabled, loader, shine]);

  useEffect(() => {
    const off = mainButton.onClick.ifAvailable(() => handle());
    return () => {
      if (off.ok) off.data();
    };
  }, []);

  useEffect(() => () => void mainButton.setParams.ifAvailable({ isVisible: false }), []);
}

/** Back from an inner (app) screen: history if we came from the hub, else the hub itself. */
export function useGoBack(): () => void {
  const router = useRouter();
  return () => {
    if (window.history.length > 1) router.back();
    else router.replace('/');
  };
}
