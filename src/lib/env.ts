import { z } from 'zod';

type EnvSource = Readonly<Record<string, string | undefined>>;

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

const botToken = () =>
  z.string().regex(/^\d+:[\w-]+$/, 'must look like <bot id>:<secret> from @BotFather');

const telegramBotToken = requiredString('is required').pipe(botToken());

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

const maxChannelsPerUser = boundedInt(1, 1000, 50);

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

const envSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrlUnpooled,
    ...botShape,
    ...llmShape,
  })
  .superRefine(requireProviderKey);

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

export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
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
  const result = botEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const miniAppShape = {
  TELEGRAM_BOT_TOKEN: telegramBotToken,
  // Lets the dev bot open the prod Mini App; its initData never grants owner rights.
  TELEGRAM_DEV_BOT_TOKEN: z.preprocess(emptyToUndefined, botToken().optional()),
  OWNER_TELEGRAM_ID: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: 'must be a positive integer Telegram user id' })
      .int('must be a positive integer Telegram user id')
      .positive('must be a positive integer Telegram user id')
      .max(Number.MAX_SAFE_INTEGER, 'must be a positive integer Telegram user id')
      .optional(),
  ),
  MAX_CHANNELS_PER_USER: maxChannelsPerUser,
  MAX_BUILDS_PER_DAY_GLOBAL: boundedInt(1, 100_000, 30),
};

const miniAppEnvSchema = z.object(miniAppShape);

export type MiniAppEnv = z.infer<typeof miniAppEnvSchema>;

/** Validates only what the Mini App API needs: no webhook secret, no LLM key. */
export function getMiniAppEnv(source: EnvSource = process.env): MiniAppEnv {
  const result = miniAppEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}

const promoEnvSchema = z.object({
  // The bot named in the "build your own newspaper" plate; unset = no plate (self-host default).
  TELEGRAM_BOT_USERNAME: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a bot username without @ (5-32 chars of A-Z, 0-9, _)')
      .optional(),
  ),
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
  // Keys the HMAC of PDF links; the page is rendered from APP_URL, never from the Host header.
  TELEGRAM_BOT_TOKEN: telegramBotToken,
  APP_URL: botShape.APP_URL,
  // Local dev only: a Chrome/Chromium binary instead of the bundled @sparticuz/chromium.
  CHROME_EXECUTABLE_PATH: optionalString(),
});

export type PdfEnv = z.infer<typeof pdfEnvSchema>;

/** Validates only what PDF links and the PDF route need. */
export function getPdfEnv(source: EnvSource = process.env): PdfEnv {
  const result = pdfEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(formatIssues(result.error));
  }
  return result.data;
}
