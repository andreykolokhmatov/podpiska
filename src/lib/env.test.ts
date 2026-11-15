import { describe, expect, it } from 'vitest';

import {
  EnvError,
  getBotEnv,
  getDatabaseUrl,
  getLlmEnv,
  getMiniAppEnv,
  getPdfEnv,
  getPromoEnv,
  parseEnv,
} from './env';

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
  const source = {
    TELEGRAM_BOT_TOKEN: validSource.TELEGRAM_BOT_TOKEN,
    APP_URL: validSource.APP_URL,
  };

  it('needs the bot token and APP_URL; the Chrome path is optional', () => {
    const env = getPdfEnv({ ...source, APP_URL: 'https://podpiska.example.com/' });
    expect(env.APP_URL).toBe('https://podpiska.example.com');
    expect(env.CHROME_EXECUTABLE_PATH).toBeUndefined();
    expect(getPdfEnv({ ...source, CHROME_EXECUTABLE_PATH: '/usr/bin/chromium' })).toMatchObject({
      CHROME_EXECUTABLE_PATH: '/usr/bin/chromium',
    });
  });

  it('rejects a missing token and an http APP_URL without echoing values', () => {
    const error = errorOf(() => getPdfEnv({ APP_URL: 'http://secret-host.example' }));
    expect(error.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(error.message).toContain('APP_URL');
    expect(error.message).not.toContain('secret-host');
  });
});
