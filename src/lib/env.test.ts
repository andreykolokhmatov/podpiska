import { describe, expect, it } from 'vitest';

import { DAILY_CHANNEL_LOOKUPS } from '@/miniapp/contract';

import { createHmac } from 'node:crypto';

import {
  accessPolicyOf,
  getAccessPolicy,
  getCronEnv,
  EnvError,
  getBotEnv,
  getDatabaseUrl,
  getLlmEnv,
  getMiniAppEnv,
  getPdfEnv,
  getPromoEnv,
  getReleaseEnv,
  isAllowedUser,
  parseEnv,
  parsePrivacyContact,
  resolveDerivedEnv,
} from './env';

const validSource = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/podpiska',
  TELEGRAM_BOT_TOKEN: '123456789:AAH-secret_token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook_secret-123',
  APP_URL: 'https://podpiska.example.com',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
  OWNER_TELEGRAM_ID: '12345',
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

describe('getLlmEnv', () => {
  const key = { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' };

  it('needs only the LLM variables and applies model defaults', () => {
    const env = getLlmEnv(key);
    expect(env.LLM_PROVIDER).toBe('google');
    expect(env.LLM_MODEL_FAST).toBe('gemini-3.5-flash-lite');
    expect(env.LLM_MODEL_SMART).toBe('gemini-3.5-flash');
    expect(env.LLM_BASE_URL).toBeUndefined();
  });

  it('treats an empty LLM_BASE_URL as direct provider access', () => {
    expect(getLlmEnv({ ...key, LLM_BASE_URL: '' }).LLM_BASE_URL).toBeUndefined();
  });

  it('strips trailing slashes from LLM_BASE_URL', () => {
    const env = getLlmEnv({ ...key, LLM_BASE_URL: 'https://api.proxyapi.ru/google/v1beta/' });
    expect(env.LLM_BASE_URL).toBe('https://api.proxyapi.ru/google/v1beta');
  });

  it('rejects a non-http LLM_BASE_URL', () => {
    const error = errorOf(() => getLlmEnv({ ...key, LLM_BASE_URL: 'ftp://example.com' }));
    expect(error.message).toContain('LLM_BASE_URL');
  });

  it('requires the key without echoing other values', () => {
    const error = errorOf(() => getLlmEnv({ LLM_MODEL_FAST: 'secret-model' }));
    expect(error.message).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(error.message).not.toContain('secret-model');
  });
});

describe('getBotEnv', () => {
  const bot = {
    TELEGRAM_BOT_TOKEN: validSource.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: validSource.TELEGRAM_WEBHOOK_SECRET,
    APP_URL: 'https://podpiska.example.com/',
  };

  it('needs neither the LLM key nor the database', () => {
    const env = getBotEnv(bot);
    expect(env.APP_URL).toBe('https://podpiska.example.com');
    expect(env.MAX_CHANNELS_PER_USER).toBe(50);
  });

  it('rejects an http APP_URL', () => {
    const error = errorOf(() => getBotEnv({ ...bot, APP_URL: 'http://localhost:3000' }));
    expect(error.message).toContain('APP_URL');
    expect(error.message).not.toContain('localhost');
    expect(() => parseEnv({ ...validSource, APP_URL: 'http://podpiska.example.com' })).toThrow(
      EnvError,
    );
  });

  it('parses MAX_CHANNELS_PER_USER and treats empty as the default', () => {
    expect(getBotEnv({ ...bot, MAX_CHANNELS_PER_USER: '7' }).MAX_CHANNELS_PER_USER).toBe(7);
    expect(getBotEnv({ ...bot, MAX_CHANNELS_PER_USER: '' }).MAX_CHANNELS_PER_USER).toBe(50);
    for (const bad of ['0', '1001', '2.5', 'many']) {
      const error = errorOf(() => getBotEnv({ ...bot, MAX_CHANNELS_PER_USER: bad }));
      expect(error.message).toContain('MAX_CHANNELS_PER_USER');
    }
  });

  it('requires the token and the webhook secret without echoing values', () => {
    const error = errorOf(() =>
      getBotEnv({ APP_URL: bot.APP_URL, TELEGRAM_BOT_TOKEN: 'oops-SECRET' }),
    );
    expect(error.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(error.message).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(error.message).not.toContain('oops-SECRET');
  });
});

describe('getMiniAppEnv', () => {
  const app = { TELEGRAM_BOT_TOKEN: validSource.TELEGRAM_BOT_TOKEN };

  it('needs only the bot token and applies defaults', () => {
    const env = getMiniAppEnv(app);
    expect(env.TELEGRAM_DEV_BOT_TOKEN).toBeUndefined();
    expect(env.OWNER_TELEGRAM_ID).toBeUndefined();
    expect(env.MAX_CHANNELS_PER_USER).toBe(50);
    expect(env.MAX_BUILDS_PER_DAY_GLOBAL).toBe(30);
    expect(env.MAX_CHANNEL_LOOKUPS_PER_DAY).toBe(DAILY_CHANNEL_LOOKUPS);
  });

  it('parses MAX_CHANNEL_LOOKUPS_PER_DAY and rejects out-of-range values', () => {
    const lookups = (value: string) =>
      getMiniAppEnv({ ...app, MAX_CHANNEL_LOOKUPS_PER_DAY: value }).MAX_CHANNEL_LOOKUPS_PER_DAY;
    expect(lookups('42')).toBe(42);
    expect(lookups('')).toBe(300);
    const error = errorOf(() => lookups('0'));
    expect(error.message).toContain('MAX_CHANNEL_LOOKUPS_PER_DAY');
  });

  it('parses the optional dev token, owner id and global cap', () => {
    const env = getMiniAppEnv({
      ...app,
      TELEGRAM_DEV_BOT_TOKEN: '987654321:dev-token',
      OWNER_TELEGRAM_ID: '12345',
      MAX_BUILDS_PER_DAY_GLOBAL: '5',
    });
    expect(env.TELEGRAM_DEV_BOT_TOKEN).toBe('987654321:dev-token');
    expect(env.OWNER_TELEGRAM_ID).toBe(12345);
    expect(env.MAX_BUILDS_PER_DAY_GLOBAL).toBe(5);
  });

  it('treats empty optional values as not set', () => {
    const env = getMiniAppEnv({ ...app, TELEGRAM_DEV_BOT_TOKEN: '', OWNER_TELEGRAM_ID: ' ' });
    expect(env.TELEGRAM_DEV_BOT_TOKEN).toBeUndefined();
    expect(env.OWNER_TELEGRAM_ID).toBeUndefined();
  });

  it('rejects bad values without echoing them', () => {
    const error = errorOf(() =>
      getMiniAppEnv({
        TELEGRAM_DEV_BOT_TOKEN: 'dev-SECRET',
        OWNER_TELEGRAM_ID: '-4',
        MAX_BUILDS_PER_DAY_GLOBAL: '0',
      }),
    );
    for (const key of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_DEV_BOT_TOKEN',
      'OWNER_TELEGRAM_ID',
      'MAX_BUILDS_PER_DAY_GLOBAL',
    ]) {
      expect(error.message).toContain(key);
    }
    expect(error.message).not.toContain('dev-SECRET');
  });
});

describe('getPromoEnv', () => {
  it('treats an unset or empty username as no plate', () => {
    expect(getPromoEnv({}).TELEGRAM_BOT_USERNAME).toBeUndefined();
    expect(getPromoEnv({ TELEGRAM_BOT_USERNAME: '' }).TELEGRAM_BOT_USERNAME).toBeUndefined();
  });

  it('accepts a bot username', () => {
    const env = getPromoEnv({ TELEGRAM_BOT_USERNAME: 'podpiska_news_bot' });
    expect(env.TELEGRAM_BOT_USERNAME).toBe('podpiska_news_bot');
  });

  it.each(['@podpiska_news_bot', 'abc', 'x'.repeat(33), 'bad-name', 'https://t.me/bot'])(
    'rejects %j without echoing it',
    (value) => {
      const error = errorOf(() => getPromoEnv({ TELEGRAM_BOT_USERNAME: value }));
      expect(error.message).toContain('TELEGRAM_BOT_USERNAME');
      expect(error.message).not.toContain(value);
    },
  );
});

describe('getPdfEnv', () => {
  const source = { APP_URL: validSource.APP_URL };

  it('needs APP_URL; the Chrome path is optional', () => {
    const env = getPdfEnv({ ...source, APP_URL: 'https://podpiska.example.com/' });
    expect(env.APP_URL).toBe('https://podpiska.example.com');
    expect(env.CHROME_EXECUTABLE_PATH).toBeUndefined();
    expect(getPdfEnv({ ...source, CHROME_EXECUTABLE_PATH: '/usr/bin/chromium' })).toMatchObject({
      CHROME_EXECUTABLE_PATH: '/usr/bin/chromium',
    });
  });

  it('rejects an http APP_URL without echoing values', () => {
    const error = errorOf(() => getPdfEnv({ APP_URL: 'http://secret-host.example' }));
    expect(error.message).toContain('APP_URL');
    expect(error.message).not.toContain('secret-host');
  });
});

describe('getCronEnv', () => {
  const secret = 'a'.repeat(64);
  const source = {
    CRON_SECRET: secret,
    TELEGRAM_BOT_TOKEN: validSource.TELEGRAM_BOT_TOKEN,
    APP_URL: validSource.APP_URL,
  };

  it('needs a long secret, the bot token and APP_URL; the global cap defaults to 30', () => {
    const env = getCronEnv(source);
    expect(env.CRON_SECRET).toBe(secret);
    expect(env.MAX_BUILDS_PER_DAY_GLOBAL).toBe(30);
  });

  it('refuses a short explicit secret without echoing it', () => {
    const error = errorOf(() => getCronEnv({ ...source, CRON_SECRET: 'short-secret' }));
    expect(error.message).toContain('CRON_SECRET');
    expect(error.message).not.toContain('short-secret');
  });

  it.each([undefined, '', '   '])(
    'derives a missing or empty secret from the token (%j)',
    (value) => {
      const env = getCronEnv({ ...source, CRON_SECRET: value });
      expect(env.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it('refuses a missing secret when there is no token to derive it from', () => {
    const error = errorOf(() =>
      getCronEnv({ APP_URL: validSource.APP_URL, CRON_SECRET: undefined }),
    );
    expect(error.message).toContain('CRON_SECRET');
    expect(error.message).toContain('TELEGRAM_BOT_TOKEN');
  });
});

describe('resolveDerivedEnv', () => {
  const token = validSource.TELEGRAM_BOT_TOKEN;
  const hmac = (purpose: string) => createHmac('sha256', token).update(purpose).digest('hex');

  it('derives APP_URL from the Vercel production domain and secrets from the token', () => {
    const out = resolveDerivedEnv({
      TELEGRAM_BOT_TOKEN: token,
      VERCEL_PROJECT_PRODUCTION_URL: 'podpiska-fork.vercel.app',
    });
    expect(out.APP_URL).toBe('https://podpiska-fork.vercel.app');
    expect(out.TELEGRAM_WEBHOOK_SECRET).toBe(hmac('podpiska/webhook-secret/v1'));
    expect(out.CRON_SECRET).toBe(hmac('podpiska/cron-secret/v1'));
    expect(out.TELEGRAM_WEBHOOK_SECRET).not.toBe(out.CRON_SECRET);
  });

  it('is deterministic and differs per token', () => {
    const a = resolveDerivedEnv({ TELEGRAM_BOT_TOKEN: token });
    const b = resolveDerivedEnv({ TELEGRAM_BOT_TOKEN: token });
    const c = resolveDerivedEnv({ TELEGRAM_BOT_TOKEN: '987:other' });
    expect(a).toEqual(b);
    expect(c.CRON_SECRET).not.toBe(a.CRON_SECRET);
  });

  it('lets explicit values win and treats empty strings as unset', () => {
    const explicit = resolveDerivedEnv({
      TELEGRAM_BOT_TOKEN: token,
      VERCEL_PROJECT_PRODUCTION_URL: 'other.vercel.app',
      APP_URL: 'https://podpiska.example.com',
      TELEGRAM_WEBHOOK_SECRET: 'explicit_webhook',
      CRON_SECRET: 'x'.repeat(40),
    });
    expect(explicit.APP_URL).toBe('https://podpiska.example.com');
    expect(explicit.TELEGRAM_WEBHOOK_SECRET).toBe('explicit_webhook');
    expect(explicit.CRON_SECRET).toBe('x'.repeat(40));

    const empty = resolveDerivedEnv({
      TELEGRAM_BOT_TOKEN: token,
      VERCEL_PROJECT_PRODUCTION_URL: 'fork.vercel.app',
      APP_URL: '',
      TELEGRAM_WEBHOOK_SECRET: ' ',
      CRON_SECRET: '',
    });
    expect(empty.APP_URL).toBe('https://fork.vercel.app');
    expect(empty.TELEGRAM_WEBHOOK_SECRET).toBe(hmac('podpiska/webhook-secret/v1'));
    expect(empty.CRON_SECRET).toBe(hmac('podpiska/cron-secret/v1'));
  });

  it('derives nothing from a missing or malformed token', () => {
    expect(resolveDerivedEnv({}).CRON_SECRET).toBeUndefined();
    expect(
      resolveDerivedEnv({ TELEGRAM_BOT_TOKEN: 'bad' }).TELEGRAM_WEBHOOK_SECRET,
    ).toBeUndefined();
  });

  it('derived secrets pass the webhook regex and the cron minimum', () => {
    const env = getBotEnv({ TELEGRAM_BOT_TOKEN: token, APP_URL: validSource.APP_URL });
    expect(env.TELEGRAM_WEBHOOK_SECRET).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    const cron = getCronEnv({ TELEGRAM_BOT_TOKEN: token, APP_URL: validSource.APP_URL });
    expect(cron.CRON_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('still requires APP_URL outside Vercel, without echoing values', () => {
    const error = errorOf(() => getBotEnv({ TELEGRAM_BOT_TOKEN: token }));
    expect(error.message).toContain('APP_URL: is required');
    expect(error.message).not.toContain(token);
  });

  it('feeds parseEnv, which then needs only the three self-host values and a database', () => {
    const env = parseEnv({
      DATABASE_URL: validSource.DATABASE_URL,
      TELEGRAM_BOT_TOKEN: token,
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
      OWNER_TELEGRAM_ID: '42',
      VERCEL_PROJECT_PRODUCTION_URL: 'fork.vercel.app',
    });
    expect(env.APP_URL).toBe('https://fork.vercel.app');
    expect(env.CRON_SECRET).toBe(hmac('podpiska/cron-secret/v1'));
    expect(env.LLM_CONCURRENCY).toBe(3);
    expect(env.PUBLIC).toBe(false);
  });
});

describe('access policy', () => {
  it('requires the owner on a private instance, with the @userinfobot hint', () => {
    const error = errorOf(() => parseEnv({ ...validSource, OWNER_TELEGRAM_ID: undefined }));
    expect(error.message).toContain('OWNER_TELEGRAM_ID');
    expect(error.message).toContain('@userinfobot');
    expect(() => getAccessPolicy({})).toThrow(EnvError);
  });

  it('opens a public instance to everyone without an owner', () => {
    const policy = getAccessPolicy({ PUBLIC: '1' });
    expect(isAllowedUser(policy, 999)).toBe(true);
    expect(parseEnv({ ...validSource, OWNER_TELEGRAM_ID: '', PUBLIC: 'true' }).PUBLIC).toBe(true);
  });

  it('admits only the owner and the allowlist on a private instance', () => {
    const policy = getAccessPolicy({ OWNER_TELEGRAM_ID: '1', ALLOWED_TELEGRAM_IDS: ' 2, 3;4 ' });
    expect([1, 2, 3, 4, 5].map((id) => isAllowedUser(policy, id))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(getAccessPolicy({ OWNER_TELEGRAM_ID: '1', PUBLIC: 'off' }).public).toBe(false);
  });

  it.each(['abc', '1,-2', '1,2.5', '9'.repeat(20)])('rejects ALLOWED_TELEGRAM_IDS %j', (value) => {
    const error = errorOf(() =>
      getAccessPolicy({ OWNER_TELEGRAM_ID: '1', ALLOWED_TELEGRAM_IDS: value }),
    );
    expect(error.message).toContain('ALLOWED_TELEGRAM_IDS');
    expect(error.message).not.toContain(value);
  });

  it('rejects a PUBLIC value that is not a flag', () => {
    const error = errorOf(() => getAccessPolicy({ PUBLIC: 'maybe' }));
    expect(error.message).toContain('PUBLIC');
  });

  it('accessPolicyOf reports a missing owner as EnvError', () => {
    const env = getMiniAppEnv({ TELEGRAM_BOT_TOKEN: validSource.TELEGRAM_BOT_TOKEN });
    expect(() => accessPolicyOf(env)).toThrow(/OWNER_TELEGRAM_ID/);
  });
});

describe('new optional settings', () => {
  it('parses LLM_CONCURRENCY in 1..10 with default 3', () => {
    const key = { GOOGLE_GENERATIVE_AI_API_KEY: 'k' };
    expect(getLlmEnv(key).LLM_CONCURRENCY).toBe(3);
    expect(getLlmEnv({ ...key, LLM_CONCURRENCY: '1' }).LLM_CONCURRENCY).toBe(1);
    for (const bad of ['0', '11', 'x']) {
      expect(errorOf(() => getLlmEnv({ ...key, LLM_CONCURRENCY: bad })).message).toContain(
        'LLM_CONCURRENCY',
      );
    }
  });

  it('parses SKIP_DB_MIGRATE and PODPISKA_CREDIT flags', () => {
    expect(getReleaseEnv({}).SKIP_DB_MIGRATE).toBe(false);
    expect(getReleaseEnv({ SKIP_DB_MIGRATE: '1', VERCEL_ENV: 'production' })).toEqual({
      SKIP_DB_MIGRATE: true,
      VERCEL_ENV: 'production',
    });
    expect(getPromoEnv({}).PODPISKA_CREDIT).toBe(true);
    expect(getPromoEnv({ PODPISKA_CREDIT: 'off' }).PODPISKA_CREDIT).toBe(false);
    expect(errorOf(() => getPromoEnv({ PODPISKA_CREDIT: 'nah' })).message).toContain(
      'PODPISKA_CREDIT',
    );
  });

  it('validates PRIVACY_CONTACT in parseEnv without echoing it', () => {
    expect(parseEnv({ ...validSource, PRIVACY_CONTACT: '@someone' }).PRIVACY_CONTACT).toBe(
      '@someone',
    );
    const error = errorOf(() => parseEnv({ ...validSource, PRIVACY_CONTACT: 'javascript:x' }));
    expect(error.message).toContain('PRIVACY_CONTACT');
    expect(error.message).not.toContain('javascript:x');
  });
});

describe('parsePrivacyContact', () => {
  it.each([
    ['andrei_working', '@andrei_working', 'https://t.me/andrei_working'],
    ['@andrei_working', '@andrei_working', 'https://t.me/andrei_working'],
    ['https://t.me/andrei_working', '@andrei_working', 'https://t.me/andrei_working'],
    ['me@example.com', 'me@example.com', 'mailto:me@example.com'],
    ['https://example.com/contact', 'https://example.com/contact', 'https://example.com/contact'],
  ])('%s → link', (raw, label, href) => {
    expect(parsePrivacyContact(raw)).toEqual({ label, href });
  });

  it.each(['javascript:alert(1)', 'http://example.com', 'a b', '@ab'])('rejects %j', (raw) => {
    expect(parsePrivacyContact(raw)).toBeNull();
  });
});
