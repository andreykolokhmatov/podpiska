import { EnvError, getPromoEnv } from '@/lib/env';

export interface NewspaperPromo {
  /** Without @, e.g. podpiska_news_bot. */
  botUsername: string;
  /** https://t.me/<botUsername> */
  url: string;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Server only: the "build your own newspaper" plate, or null when TELEGRAM_BOT_USERNAME is unset.
 * An invalid value hides the plate instead of breaking the newspaper page.
 */
export function newspaperPromo(source: EnvSource = process.env): NewspaperPromo | null {
  let botUsername: string | undefined;
  try {
    botUsername = getPromoEnv(source).TELEGRAM_BOT_USERNAME;
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    // EnvError messages list keys and reasons only, never values.
    console.error(`[newspaper] promo plate hidden: ${error.message}`);
    return null;
  }
  return botUsername === undefined ? null : { botUsername, url: `https://t.me/${botUsername}` };
}
