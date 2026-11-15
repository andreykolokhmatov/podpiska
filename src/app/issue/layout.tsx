import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import { newspaperFontVars } from '@/newspaper/fonts';
import { THEME_SCRIPT } from '@/newspaper/theme-script';

import '@/newspaper/newspaper.css';

import { MiniAppBridge } from '@/miniapp/client/MiniAppBridge';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F0E7' },
    { media: '(prefers-color-scheme: dark)', color: '#15140F' },
  ],
};

export default function IssueLayout({ children }: { children: ReactNode }) {
  return (
    <div className={newspaperFontVars}>
      {children}
      <script>{THEME_SCRIPT}</script>
      <MiniAppBridge />
    </div>
  );
}
