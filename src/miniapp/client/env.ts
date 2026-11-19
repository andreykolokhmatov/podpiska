/** Pure helpers shared by the Mini App and the newspaper bridge; no SDK import here. */
import { parseStartParam } from '@/miniapp/share';

export type Appearance = 'light' | 'dark';
export type UiPlatform = 'ios' | 'base';

/** telegram-ui ships two looks: iOS (iOS + macOS clients) and Material-ish base (the rest). */
export const uiPlatform = (platform: string | undefined): UiPlatform =>
  platform === 'ios' || platform === 'macos' ? 'ios' : 'base';

/**
 * `?from=app` marks a page opened from inside the Mini App, so Back may step through history.
 * history.length cannot tell: Telegram's WebView history may hold entries from before the launch.
 */
export const FROM_APP = 'from=app';

export function withFromApp(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${FROM_APP}`;
}

export const openedFromApp = (search: string): boolean =>
  new URLSearchParams(search).get('from') === 'app';

/**
 * The newspaper honours ?theme, so it matches Telegram rather than the OS setting. fromApp: opened
 * from the hub/archive (Back returns there); a start_param launch has nothing behind it.
 */
export const issueUrl = (id: string, appearance: Appearance, fromApp = false): string => {
  const url = `/issue/${encodeURIComponent(id)}?tma=1&theme=${appearance}`;
  return fromApp ? withFromApp(url) : url;
};

export const privacyUrl = (appearance: Appearance): string =>
  withFromApp(`/privacy?theme=${appearance}`);

/** sessionStorage key: the start_param already routed in this WebView session. */
export const START_CONSUMED_KEY = 'pd/startParamConsumed';

export interface FlagStore {
  get(): string | null;
  set(value: string): void;
}

/**
 * The issue a `startapp=issue_<uuid>` link should open, exactly once per launch: the launch
 * params outlive the redirect, so Back to the hub must not bounce to the issue again.
 */
export function takeStartIssue(startParam: string | undefined, store: FlagStore): string | null {
  const issueId = parseStartParam(startParam);
  if (issueId === null || startParam === undefined || store.get() === startParam) return null;
  store.set(startParam);
  return issueId;
}

/** sessionStorage with an in-memory fallback (private mode, blocked storage). */
export function sessionFlagStore(key: string, storage: () => Storage): FlagStore {
  let memory: string | null = null;
  return {
    get() {
      try {
        return storage().getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    set(value) {
      memory = value;
      try {
        storage().setItem(key, value);
      } catch {
        // Memory flag still covers this document.
      }
    },
  };
}

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
