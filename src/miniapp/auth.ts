import { isValid, parse } from '@tma.js/init-data-node';

import { AUTH_SCHEME } from './contract';

/** initData older than this is refused as expired (the client asks to restart the app). */
export const INIT_DATA_MAX_AGE_S = 86_400;
const MAX_RAW_LENGTH = 8192;

export interface MiniAppUser {
  id: number;
  firstName: string;
  username: string | null;
}

export interface MiniAppAuth {
  /** Which bot signed the initData; only 'prod' can carry owner rights. */
  bot: 'prod' | 'dev';
  user: MiniAppUser;
  allowsWriteToPm: boolean;
  authDate: Date;
}

export type AuthResult =
  { ok: true; auth: MiniAppAuth } | { ok: false; error: 'unauthorized' | 'expired' };

/** The raw initData from `Authorization: tma <raw>`, or undefined. */
export function parseAuthHeader(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^(\S+) (\S+)$/.exec(header.trim());
  if (match?.[1]?.toLowerCase() !== AUTH_SCHEME || match[2] === undefined) return undefined;
  return match[2];
}

export interface VerifyOptions {
  prodToken: string;
  devToken?: string | undefined;
  now: Date;
}

const signedBy = (raw: string, options: VerifyOptions): MiniAppAuth['bot'] | undefined => {
  // Expiry is checked below against the injected clock, so the library check is off.
  if (isValid(raw, options.prodToken, { expiresIn: 0 })) return 'prod';
  if (options.devToken !== undefined && isValid(raw, options.devToken, { expiresIn: 0 })) {
    return 'dev';
  }
  return undefined;
};

/** Validates the HMAC with the prod token, then the optional dev token. Never logs `raw`. */
export function verifyInitData(raw: string, options: VerifyOptions): AuthResult {
  if (raw.length === 0 || raw.length > MAX_RAW_LENGTH) return { ok: false, error: 'unauthorized' };
  const bot = signedBy(raw, options);
  if (bot === undefined) return { ok: false, error: 'unauthorized' };

  let data: ReturnType<typeof parse>;
  try {
    data = parse(raw);
  } catch {
    // Signed but not parseable as initData: treat like any other bad credential.
    return { ok: false, error: 'unauthorized' };
  }
  const { user } = data;
  if (user === undefined || !Number.isSafeInteger(user.id) || user.id <= 0) {
    return { ok: false, error: 'unauthorized' };
  }
  if (options.now.getTime() - data.auth_date.getTime() > INIT_DATA_MAX_AGE_S * 1000) {
    return { ok: false, error: 'expired' };
  }
  return {
    ok: true,
    auth: {
      bot,
      user: { id: user.id, firstName: user.first_name, username: user.username ?? null },
      allowsWriteToPm: user.allows_write_to_pm === true,
      authDate: data.auth_date,
    },
  };
}

/** Owner rights only for initData signed by the prod bot. */
export const isOwner = (auth: MiniAppAuth, ownerId: number | undefined): boolean =>
  auth.bot === 'prod' && ownerId !== undefined && auth.user.id === ownerId;
