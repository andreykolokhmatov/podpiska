import { describe, expect, it } from 'vitest';

import { EnvError, getDatabaseUrl, parseEnv } from './env';

const validSource = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/podpiska',
  TELEGRAM_BOT_TOKEN: '123456789:AAH-secret_token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook_secret-123',
  APP_URL: 'https://podpiska.example.com',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
};

const without = (key: keyof typeof validSource): Record<string, string> =>
  Object.fromEntries(Object.entries(validSource).filter(([k]) => k !== key));

const errorOf = (fn: () => unknown): EnvError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error('expected EnvError to be thrown');
};

describe('parseEnv', () => {
  it('parses a valid source and applies defaults', () => {
    const env = parseEnv(validSource);
    expect(env.DATABASE_URL).toBe(validSource.DATABASE_URL);
    expect(env.DATABASE_URL_UNPOOLED).toBeUndefined();
    expect(env.LLM_PROVIDER).toBe('google');
    expect(env.LLM_MODEL_FAST).toMatch(/\S/);
    expect(env.LLM_MODEL_SMART).toMatch(/\S/);
  });

  it('reports every invalid key in one error without echoing values', () => {
    const badToken = 'not-a-token-SECRET';
    const error = errorOf(() =>
      parseEnv({ ...without('DATABASE_URL'), TELEGRAM_BOT_TOKEN: badToken }),
    );

    expect(error.message).toMatch(/^Invalid environment variables:/);
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(error.message).toContain('.env.example');
    expect(error.message).not.toContain(badToken);
  });

  it('treats empty strings as missing', () => {
    const error = errorOf(() => parseEnv({ ...validSource, DATABASE_URL: '' }));
    expect(error.message).toContain('DATABASE_URL: is required');
  });

  it('requires the Google API key when the provider is google', () => {
    const error = errorOf(() =>
      parseEnv({ ...without('GOOGLE_GENERATIVE_AI_API_KEY'), LLM_PROVIDER: 'google' }),
    );
    expect(error.message).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('rejects a webhook secret with forbidden characters', () => {
    const error = errorOf(() =>
      parseEnv({ ...validSource, TELEGRAM_WEBHOOK_SECRET: 'has spaces!' }),
    );
    expect(error.message).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(error.message).not.toContain('has spaces!');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    const error = errorOf(() => parseEnv({ ...validSource, DATABASE_URL: 'mysql://localhost/db' }));
    expect(error.message).toContain('DATABASE_URL');
  });

  it('strips trailing slashes from APP_URL', () => {
    const env = parseEnv({ ...validSource, APP_URL: 'https://podpiska.example.com/' });
    expect(env.APP_URL).toBe('https://podpiska.example.com');
  });
});

describe('getDatabaseUrl', () => {
  it('works when only DATABASE_URL is set', () => {
    const source = { DATABASE_URL: validSource.DATABASE_URL };
    expect(getDatabaseUrl({}, source)).toBe(validSource.DATABASE_URL);
    expect(getDatabaseUrl({ unpooled: true }, source)).toBe(validSource.DATABASE_URL);
  });

  it('prefers DATABASE_URL_UNPOOLED for unpooled access', () => {
    const unpooled = 'postgresql://user:pass@direct.localhost:5432/podpiska';
    const source = { DATABASE_URL: validSource.DATABASE_URL, DATABASE_URL_UNPOOLED: unpooled };
    expect(getDatabaseUrl({ unpooled: true }, source)).toBe(unpooled);
    expect(getDatabaseUrl({}, source)).toBe(validSource.DATABASE_URL);
  });

  it('throws a readable error when DATABASE_URL is missing', () => {
    const error = errorOf(() => getDatabaseUrl({}, {}));
    expect(error.message).toContain('DATABASE_URL: is required');
    expect(error.message).toContain('.env.example');
  });
});
