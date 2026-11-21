import { EnvError, getPromoEnv } from '@/lib/env';

export interface NewspaperPromo {
  /** Without @, e.g. podpiska_news_bot. */
  botUsername: string;
  /** https://t.me/<botUsername> */
  url: string;
}

export interface NewspaperCredit {
  url: string;
}

export const UPSTREAM_REPO_URL = 'https://github.com/andreykolokhmatov/podpiska';

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Server only: the "build your own newspaper" plate, or null when TELEGRAM_BOT_USERNAME is unset.
 * An invalid value hides the plate instead of breaking the newspaper page.
 */
export function newspaperPromo(source: EnvSource = process.env): NewspaperPromo | null {
  let botUsername: string | undefined;
  try {
    // Only this key, so a bad PODPISKA_CREDIT cannot hide the plate.
    botUsername = getPromoEnv({
      TELEGRAM_BOT_USERNAME: source.TELEGRAM_BOT_USERNAME,
    }).TELEGRAM_BOT_USERNAME;
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    // EnvError messages list keys and reasons only, never values.
    console.error(`[newspaper] promo plate hidden: ${error.message}`);
    return null;
  }
  return botUsername === undefined ? null : { botUsername, url: `https://t.me/${botUsername}` };
}

/**
 * Server only: the upstream "made with Podpiska" credit, on unless PODPISKA_CREDIT is off.
 * Independent of the promo plate; an invalid value keeps the default (shown).
 */
export function newspaperCredit(source: EnvSource = process.env): NewspaperCredit | null {
  let enabled = true;
  try {
    enabled = getPromoEnv({ PODPISKA_CREDIT: source.PODPISKA_CREDIT }).PODPISKA_CREDIT;
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`[newspaper] credit kept on: ${error.message}`);
  }
  return enabled ? { url: UPSTREAM_REPO_URL } : null;
}
