/** Pure helpers shared by the Mini App and the newspaper bridge; no SDK import here. */

export type Appearance = 'light' | 'dark';
export type UiPlatform = 'ios' | 'base';

/** telegram-ui ships two looks: iOS (iOS + macOS clients) and Material-ish base (the rest). */
export const uiPlatform = (platform: string | undefined): UiPlatform =>
  platform === 'ios' || platform === 'macos' ? 'ios' : 'base';

/** The newspaper honours ?theme, so it matches Telegram rather than the OS setting. */
export const issueUrl = (id: string, appearance: Appearance): string =>
  `/issue/${encodeURIComponent(id)}?tma=1&theme=${appearance}`;

export const privacyUrl = (appearance: Appearance): string => `/privacy?theme=${appearance}`;

/** tma.js keeps launch params in sessionStorage under this key across full page loads. */
export const LAUNCH_PARAMS_KEY = 'tapps/launchParams';

interface LocationLike {
  search: string;
  hash: string;
}

/**
 * Cheap pre-check before loading the SDK on server-rendered pages (newspaper, privacy): a plain
 * browser must not download it. The SDK's own isTMA() confirms afterwards.
 */
export function looksLikeTma(location: LocationLike, storedLaunchParams: string | null): boolean {
  if (new URLSearchParams(location.search).get('tma') === '1') return true;
  if (location.hash.includes('tgWebAppData') || location.hash.includes('tgWebAppPlatform')) {
    return true;
  }
  return storedLaunchParams !== null;
}

export function initials(first: string | null | undefined, last?: string | null): string {
  const letters = [first, last]
    .map((part) => part?.trim().charAt(0) ?? '')
    .join('')
    .toUpperCase();
  return letters || '?';
}
