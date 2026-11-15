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

const envSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrlUnpooled,
    TELEGRAM_BOT_TOKEN: requiredString('is required').pipe(
      z.string().regex(/^\d+:[\w-]+$/, 'must look like <bot id>:<secret> from @BotFather'),
    ),
    TELEGRAM_WEBHOOK_SECRET: requiredString('is required').pipe(
      z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'must be 1-256 chars of A-Z, a-z, 0-9, _ or -'),
    ),
    APP_URL: requiredString('is required').pipe(
      z
        .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
        .transform((value) => value.replace(/\/+$/, '')),
    ),
    LLM_PROVIDER: z.preprocess(
      emptyToUndefined,
      z
        .enum(llmProviders, { error: `must be one of: ${llmProviders.join(', ')}` })
        .default('google'),
    ),
    LLM_MODEL_FAST: z.preprocess(emptyToUndefined, z.string().min(1).default('gemini-2.5-flash')),
    LLM_MODEL_SMART: z.preprocess(emptyToUndefined, z.string().min(1).default('gemini-2.5-pro')),
    GOOGLE_GENERATIVE_AI_API_KEY: optionalString(),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'google' && env.GOOGLE_GENERATIVE_AI_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_GENERATIVE_AI_API_KEY'],
        message: 'is required when LLM_PROVIDER=google',
      });
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
