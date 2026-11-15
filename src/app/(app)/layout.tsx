import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { TmaRoot } from '@/miniapp/client/TmaRoot';

// telegram-ui styles live only in this tree; /issue and /privacy never load them.
import '@telegram-apps/telegram-ui/dist/styles.css';
import '@/miniapp/client/miniapp.css';

export const metadata: Metadata = {
  title: 'Подписка',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function MiniAppLayout({ children }: { children: ReactNode }) {
  return <TmaRoot>{children}</TmaRoot>;
}
