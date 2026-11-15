'use client';

import { AppRoot } from '@telegram-apps/telegram-ui';
import { useEffect, useState, type ReactNode } from 'react';

import { TmaContext, useAppearance } from './hooks';
import { OutsideTelegram } from './screens/OutsideTelegram';
import { initTmaOnce, navigateFull, type TmaEnv } from './sdk';

interface TmaRootProps {
  children: ReactNode;
}

/**
 * Gate for every (app) screen. Server HTML and the first client render are the same neutral
 * spinner; the Telegram environment is only read after mount, so nothing can mismatch.
 */
export function TmaRoot({ children }: TmaRootProps) {
  const [env, setEnv] = useState<TmaEnv | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let offPageShow: (() => void) | undefined;
    void initTmaOnce().then((value) => {
      if (!alive) return;
      if (value?.redirect) {
        // Opened by a shared issue link: go straight to the newspaper, render no screen (no API
        // call, so a reader is not registered). Back may restore this page from bfcache, frozen
        // mid-navigation; rendering the app on top of that crashed into Next's error page on iOS.
        // Reload instead: the start param is consumed, so it comes back as a normal launch.
        const onPageShow = (event: PageTransitionEvent) => {
          if (event.persisted) window.location.reload();
        };
        window.addEventListener('pageshow', onPageShow);
        offPageShow = () => window.removeEventListener('pageshow', onPageShow);
        navigateFull(value.redirect);
        return;
      }
      setEnv(value);
    });
    return () => {
      alive = false;
      offPageShow?.();
    };
  }, []);

  if (env === undefined) {
    return (
      <div className="pd-splash" role="status" aria-label="Загрузка">
        <span className="pd-spinner" />
      </div>
    );
  }
  if (env === null) {
    return (
      <AppRoot>
        <OutsideTelegram />
      </AppRoot>
    );
  }
  return <TmaApp env={env}>{children}</TmaApp>;
}

function TmaApp({ env, children }: { env: TmaEnv; children: ReactNode }) {
  const appearance = useAppearance();
  return (
    <AppRoot
      appearance={appearance}
      platform={env.platform}
      className={`pd-root pd-root--${env.platform}`}
    >
      <TmaContext value={env}>{children}</TmaContext>
    </AppRoot>
  );
}
