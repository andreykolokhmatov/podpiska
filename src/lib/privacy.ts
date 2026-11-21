import {
  EnvError,
  getLlmEnv,
  parsePrivacyContact,
  type EnvSource,
  type PrivacyContact,
} from './env';

export type { PrivacyContact };

const GOOGLE_API_HOST = 'generativelanguage.googleapis.com';

/** Where interests and posts go: Google's API directly, or a proxy in front of it. */
export type PrivacyLlmRoute = { kind: 'direct' } | { kind: 'proxy'; host: string | null };

export interface PrivacyInfo {
  /** null: no PRIVACY_CONTACT (or an invalid one); the page names the instance's bot instead. */
  contact: PrivacyContact | null;
  llm: PrivacyLlmRoute;
}

/**
 * Server only: what the /privacy page states about this instance. Never throws; an invalid
 * value is logged (key name only) and shown as unknown rather than breaking the page.
 */
export function getPrivacyInfo(source: EnvSource = process.env): PrivacyInfo {
  const rawContact = source.PRIVACY_CONTACT?.trim();
  let contact: PrivacyContact | null = null;
  if (rawContact !== undefined && rawContact !== '') {
    contact = parsePrivacyContact(rawContact);
    if (contact === null) console.error('[privacy] PRIVACY_CONTACT is invalid; contact hidden');
  }

  const rawBase = source.LLM_BASE_URL?.trim();
  let llm: PrivacyLlmRoute = { kind: 'direct' };
  if (rawBase !== undefined && rawBase !== '') {
    try {
      // The key is irrelevant here; only LLM_BASE_URL is read from the parsed result.
      const base = getLlmEnv({
        LLM_BASE_URL: rawBase,
        GOOGLE_GENERATIVE_AI_API_KEY: 'x',
      }).LLM_BASE_URL;
      const host = base === undefined ? null : new URL(base).hostname;
      llm = host === GOOGLE_API_HOST ? { kind: 'direct' } : { kind: 'proxy', host };
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      console.error('[privacy] LLM_BASE_URL is invalid');
      llm = { kind: 'proxy', host: null };
    }
  }
  return { contact, llm };
}
