'use client';

import { AppRoot } from '@telegram-apps/telegram-ui';
import { useEffect, useState, type ReactNode } from 'react';

import { TmaContext, useAppearance } from './hooks';
import { OutsideTelegram } from './screens/OutsideTelegram';
import { initTmaOnce, type TmaEnv } from './sdk';

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
    void initTmaOnce().then((value) => {
      if (alive) setEnv(value);
    });
    return () => {
      alive = false;
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
    <AppRoot appearance={appearance} platform={env.platform} className="pd-root">
      <TmaContext value={env}>{children}</TmaContext>
    </AppRoot>
  );
}
