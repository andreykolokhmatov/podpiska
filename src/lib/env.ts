import { createHmac } from 'node:crypto';

import { z } from 'zod';

// Server only (node:crypto): never import this module from client components.

export type EnvSource = Readonly<Record<string, string | undefined>>;

// Empty strings (e.g. `KEY=` in .env) must count as "not set".
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requiredString = (message: string) =>
  z.preprocess(emptyToUndefined, z.string({ error: 'is required' }).min(1, message));

const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());

const isPostgresUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
};

const postgresUrl = (message: string) => z.string().refine(isPostgresUrl, { message });

const databaseUrl = z.preprocess(
  emptyToUndefined,
  z
    .string({ error: 'is required' })
    .pipe(postgresUrl('must be a postgres:// or postgresql:// URL')),
);

const databaseUrlUnpooled = z.preprocess(
  emptyToUndefined,
  postgresUrl('must be a postgres:// or postgresql:// URL').optional(),
);

const llmProviders = ['google'] as const;

const boundedInt = (min: number, max: number, fallback: number) => {
  const message = `must be an integer ${min}..${max}`;
  return z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: message })
      .int(message)
      .min(min, message)
      .max(max, message)
      .default(fallback),
  );
};

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/** 1/true/yes/on or 0/false/no/off (any case); empty = the default. */
const flag = (fallback: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((value, ctx) => {
        const word = value.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
        ctx.addIssue({ code: 'custom', message: 'must be 1/true/on or 0/false/off' });
        return z.NEVER;
      })
      .default(fallback),
  );

const llmShape = {
  LLM_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(llmProviders, { error: `must be one of: ${llmProviders.join(', ')}` }).default('google'),
  ),
  LLM_MODEL_FAST: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default('gemini-3.5-flash-lite'),
  ),
  LLM_MODEL_SMART: z.preprocess(emptyToUndefined, z.string().min(1).default('gemini-3.5-flash')),
  // Empty means the provider's own API (e.g. generativelanguage.googleapis.com).
  LLM_BASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .transform((value) => value.replace(/\/+$/, ''))
      .optional(),
  ),
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString(),
  // Parallel LLM calls of one build; 1 suits a free-tier key with a low RPM.
  LLM_CONCURRENCY: boundedInt(1, 10, 3),
};

const requireProviderKey = (
  env: { LLM_PROVIDER: string; GOOGLE_GENERATIVE_AI_API_KEY?: string | undefined },
  ctx: z.RefinementCtx,
): void => {
  if (env.LLM_PROVIDER === 'google' && env.GOOGLE_GENERATIVE_AI_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['GOOGLE_GENERATIVE_AI_API_KEY'],
      message: 'is required when LLM_PROVIDER=google',
    });
  }
};

const BOT_TOKEN_PATTERN = /^\d+:[\w-]+$/;

const botToken = () =>
  z.string().regex(BOT_TOKEN_PATTERN, 'must look like <bot id>:<secret> from @BotFather');

const telegramBotToken = requiredString('is required').pipe(botToken());

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

const deriveSecret = (token: string, purpose: string): string =>
  createHmac('sha256', token).update(purpose).digest('hex');

/**
 * Fills APP_URL, TELEGRAM_WEBHOOK_SECRET and CRON_SECRET when they are unset (or empty):
 * APP_URL from Vercel's production domain, the secrets as HMACs of the bot token, so a
 * self-hosted deploy needs neither. An explicit value always wins. The token is the root of
 * trust (it already controls the bot); rotate a secret alone by setting it explicitly.
 */
export function resolveDerivedEnv(source: EnvSource): EnvSource {
  const derived: Record<string, string | undefined> = { ...source };
  const host = source.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!isSet(source.APP_URL) && host !== undefined && host !== '') {
    derived.APP_URL = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  }
  const token = source.TELEGRAM_BOT_TOKEN?.trim();
  // A malformed token is reported as such; deriving from it would only hide that.
  if (token !== undefined && BOT_TOKEN_PATTERN.test(token)) {
    if (!isSet(source.TELEGRAM_WEBHOOK_SECRET)) {
      derived.TELEGRAM_WEBHOOK_SECRET = deriveSecret(token, 'podpiska/webhook-secret/v1');
    }
    if (!isSet(source.CRON_SECRET)) {
      derived.CRON_SECRET = deriveSecret(token, 'podpiska/cron-secret/v1');
    }
  }
  return derived;
}

const telegramUserId = (message: string) =>
  z.coerce
    .number({ error: message })
    .int(message)
    .positive(message)
    .max(Number.MAX_SAFE_INTEGER, message);

const ownerTelegramId = z.preprocess(
  emptyToUndefined,
  telegramUserId('must be a positive integer Telegram user id').optional(),
);

const ALLOWED_IDS_MESSAGE = 'must be positive integer Telegram user ids separated by commas';

const allowedTelegramIds = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .transform((value, ctx) => {
      const ids: number[] = [];
      for (const part of value.split(/[\s,;]+/)) {
        if (part === '') continue;
        const id = /^\d+$/.test(part) ? Number(part) : Number.NaN;
        if (!Number.isSafeInteger(id) || id <= 0) {
          ctx.addIssue({ code: 'custom', message: ALLOWED_IDS_MESSAGE });
          return z.NEVER;
        }
        ids.push(id);
      }
      return ids;
    })
    .default([]),
);

const accessShape = {
  // Open to every Telegram user (the hosted bot); unset = a private instance.
  PUBLIC: flag(false),
  OWNER_TELEGRAM_ID: ownerTelegramId,
  ALLOWED_TELEGRAM_IDS: allowedTelegramIds,
};

const PRIVATE_NEEDS_OWNER =
  'is required for a private instance: your numeric Telegram id (ask @userinfobot), or set PUBLIC=1 to open the bot to everyone';

const requireOwnerWhenPrivate = (
  env: { PUBLIC: boolean; OWNER_TELEGRAM_ID?: number | undefined },
  ctx: z.RefinementCtx,
): void => {
  if (!env.PUBLIC && env.OWNER_TELEGRAM_ID === undefined) {
    ctx.addIssue({ code: 'custom', path: ['OWNER_TELEGRAM_ID'], message: PRIVATE_NEEDS_OWNER });
  }
};

const maxChannelsPerUser = boundedInt(1, 1000, 50);
const maxBuildsPerDayGlobal = boundedInt(1, 100_000, 30);
// Same default as DAILY_CHANNEL_LOOKUPS in the Mini App contract.
const maxChannelLookupsPerDay = boundedInt(1, 100_000, 300);

// Telegram webhooks and Mini Apps require https, so http is rejected even for dev.
const botShape = {
  TELEGRAM_BOT_TOKEN: telegramBotToken,
  TELEGRAM_WEBHOOK_SECRET: requiredString('is required').pipe(
    z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'must be 1-256 chars of A-Z, a-z, 0-9, _ or -'),
  ),
  APP_URL: requiredString('is required').pipe(
    z
      .url({ protocol: /^https$/, error: 'must be an https URL' })
      .transform((value) => value.replace(/\/+$/, '')),
  ),
  MAX_CHANNELS_PER_USER: maxChannelsPerUser,
};

const cronSecret = requiredString('is required').pipe(
  z.string().trim().min(32, 'must be at least 32 chars (or leave unset to derive it)'),
);

const envSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrlUnpooled,
    ...botShape,
    ...llmShape,
    ...accessShape,
    CRON_SECRET: cronSecret,
    PRIVACY_CONTACT: z.preprocess(emptyToUndefined, z.string().optional()),
  })
  .superRefine((env, ctx) => {
    requireProviderKey(env, ctx);
    requireOwnerWhenPrivate(env, ctx);
    if (env.PRIVACY_CONTACT !== undefined && parsePrivacyContact(env.PRIVACY_CONTACT) === null) {
      ctx.addIssue({ code: 'custom', path: ['PRIVACY_CONTACT'], message: PRIVACY_CONTACT_MESSAGE });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

// Messages carry only keys and reasons: values may be secrets and must never be echoed.
const formatIssues = (error: z.ZodError): string => {
  const lines = error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `  - ${key}: ${issue.message}`;
  });
  return `Invalid environment variables:\n${lines.join('\n')}\nSee .env.example`;
};

/** Everything a production deploy needs (the release step checks it before migrating). */
export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(resolveDerivedEnv(source));
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

let cachedEnv: Env | undefined;

/** Parsed lazily on first use, so `next build` never needs runtime secrets. */
export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}

const databaseUrlSchema = z.object({
  DATABASE_URL: databaseUrl,
  DATABASE_URL_UNPOOLED: databaseUrlUnpooled,
});

/**
 * Validates only the database variables. With `unpooled`, prefers
 * DATABASE_URL_UNPOOLED (Neon's pooled endpoint is unreliable for DDL/migrations).
 */
export function getDatabaseUrl(
  options: { unpooled?: boolean } = {},
  source: EnvSource = process.env,
): string {
  const result = databaseUrlSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  const { DATABASE_URL, DATABASE_URL_UNPOOLED } = result.data;
  return options.unpooled === true ? (DATABASE_URL_UNPOOLED ?? DATABASE_URL) : DATABASE_URL;
}

const llmEnvSchema = z.object(llmShape).superRefine(requireProviderKey);

export type LlmEnv = z.infer<typeof llmEnvSchema>;

/** Validates only the LLM variables, so CLIs need no Telegram/app settings. */
export function getLlmEnv(source: EnvSource = process.env): LlmEnv {
  const result = llmEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const botEnvSchema = z.object(botShape);

export type BotEnv = z.infer<typeof botEnvSchema>;

/** Validates only the bot variables: the bot needs no LLM key. */
export function getBotEnv(source: EnvSource = process.env): BotEnv {
  const result = botEnvSchema.safeParse(resolveDerivedEnv(source));
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const miniAppShape = {
  TELEGRAM_BOT_TOKEN: telegramBotToken,
  // Lets the dev bot open the prod Mini App; its initData never grants owner rights.
  TELEGRAM_DEV_BOT_TOKEN: z.preprocess(emptyToUndefined, botToken().optional()),
  ...accessShape,
  MAX_CHANNELS_PER_USER: maxChannelsPerUser,
  MAX_BUILDS_PER_DAY_GLOBAL: maxBuildsPerDayGlobal,
  MAX_CHANNEL_LOOKUPS_PER_DAY: maxChannelLookupsPerDay,
};

const miniAppEnvSchema = z.object(miniAppShape);

export type MiniAppEnv = z.infer<typeof miniAppEnvSchema>;

/**
 * Validates only what the Mini App API needs: no webhook secret, no LLM key. The access fields
 * are parsed but a private instance without an owner is reported by accessPolicyOf, so routes
 * that only need the token (emoji, public bot info) keep working.
 */
export function getMiniAppEnv(source: EnvSource = process.env): MiniAppEnv {
  const result = miniAppEnvSchema.safeParse(resolveDerivedEnv(source));
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

export interface AccessPolicy {
  public: boolean;
  /** OWNER_TELEGRAM_ID ∪ ALLOWED_TELEGRAM_IDS; ignored when public. */
  allowed: ReadonlySet<number>;
}

type AccessFields = Pick<MiniAppEnv, 'PUBLIC' | 'OWNER_TELEGRAM_ID' | 'ALLOWED_TELEGRAM_IDS'>;

/** Throws EnvError for a private instance without OWNER_TELEGRAM_ID (nobody could use it). */
export function accessPolicyOf(env: AccessFields): AccessPolicy {
  if (!env.PUBLIC && env.OWNER_TELEGRAM_ID === undefined) {
    throw new EnvError(
      `Invalid environment variables:\n  - OWNER_TELEGRAM_ID: ${PRIVATE_NEEDS_OWNER}\nSee .env.example`,
    );
  }
  const allowed = new Set(env.ALLOWED_TELEGRAM_IDS);
  if (env.OWNER_TELEGRAM_ID !== undefined) allowed.add(env.OWNER_TELEGRAM_ID);
  return { public: env.PUBLIC, allowed };
}

const accessEnvSchema = z.object(accessShape);

/** The access policy alone (the bot needs no Mini App settings). */
export function getAccessPolicy(source: EnvSource = process.env): AccessPolicy {
  const result = accessEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return accessPolicyOf(result.data);
}

export const isAllowedUser = (policy: AccessPolicy, telegramUserId: number): boolean =>
  policy.public || policy.allowed.has(telegramUserId);

const promoEnvSchema = z.object({
  // The bot named in the "build your own newspaper" plate; unset = no plate (self-host default).
  TELEGRAM_BOT_USERNAME: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a bot username without @ (5-32 chars of A-Z, 0-9, _)')
      .optional(),
  ),
  // The "Made with Podpiska → GitHub" credit in the colophon; off hides it.
  PODPISKA_CREDIT: flag(true),
});

export type PromoEnv = z.infer<typeof promoEnvSchema>;

/** Validates only the optional promo plate variable. */
export function getPromoEnv(source: EnvSource = process.env): PromoEnv {
  const result = promoEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const pdfEnvSchema = z.object({
  // The page is rendered from APP_URL, never from the Host header.
  APP_URL: botShape.APP_URL,
  // Local dev only: a Chrome/Chromium binary instead of the bundled @sparticuz/chromium.
  CHROME_EXECUTABLE_PATH: optionalString(),
});

export type PdfEnv = z.infer<typeof pdfEnvSchema>;

/** Validates only what rendering the issue PDF needs. */
export function getPdfEnv(source: EnvSource = process.env): PdfEnv {
  const result = pdfEnvSchema.safeParse(resolveDerivedEnv(source));
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const cronEnvSchema = z.object({
  // Bearer secret of /api/cron/*; never optional, so the endpoints can never be open.
  // Trimmed: a value pasted from a terminal often carries a trailing newline, which made the
  // dashboard value and the GitHub secret look equal while never matching.
  CRON_SECRET: cronSecret,
  APP_URL: botShape.APP_URL,
  TELEGRAM_BOT_TOKEN: telegramBotToken,
  MAX_BUILDS_PER_DAY_GLOBAL: maxBuildsPerDayGlobal,
});

export type CronEnv = z.infer<typeof cronEnvSchema>;

/** Validates what the scheduled-issue cron routes need (the LLM env is checked separately). */
export function getCronEnv(source: EnvSource = process.env): CronEnv {
  const result = cronEnvSchema.safeParse(resolveDerivedEnv(source));
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const releaseEnvSchema = z.object({
  VERCEL_ENV: optionalString(),
  // Turns the build-time migrations (and bot setup) off, e.g. while migrating by hand.
  SKIP_DB_MIGRATE: flag(false),
});

export type ReleaseEnv = z.infer<typeof releaseEnvSchema>;

/** What decides whether the build-time release step runs at all. */
export function getReleaseEnv(source: EnvSource = process.env): ReleaseEnv {
  const result = releaseEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

export const PRIVACY_CONTACT_MESSAGE =
  'must be a Telegram username (@name or t.me/name), an email or an https URL';

export interface PrivacyContact {
  /** What the page shows: @name, the email or the URL. */
  label: string;
  /** https://t.me/<name>, mailto:<email> or the https URL itself. */
  href: string;
}

const TG_CONTACT = /^(?:@|(?:https?:\/\/)?t\.me\/)?([A-Za-z][A-Za-z0-9_]{3,31})$/i;
const EMAIL_CONTACT = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** PRIVACY_CONTACT as a link, or null when it is none of the accepted forms. */
export function parsePrivacyContact(raw: string): PrivacyContact | null {
  const value = raw.trim();
  const tg = TG_CONTACT.exec(value);
  if (tg?.[1] !== undefined) return { label: `@${tg[1]}`, href: `https://t.me/${tg[1]}` };
  if (EMAIL_CONTACT.test(value) && value.length <= 254) {
    return { label: value, href: `mailto:${value}` };
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return { label: value, href: url.href };
  } catch {
    // Not a URL either: reported as invalid by the caller.
  }
  return null;
}
