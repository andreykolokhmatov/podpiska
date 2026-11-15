import { describe, expect, it } from 'vitest';

import {
  buildShareResult,
  issueStartUrl,
  parseStartParam,
  SHARE_HEADLINE_MAX,
  shareTitle,
} from './share';

const ID = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e';
const BOT = 'podpiska_news_bot';

describe('buildShareResult', () => {
  it('builds the exact card with a url button to the startapp link', () => {
    const result = buildShareResult({
      issueId: ID,
      number: 4,
      headline: 'Омск строит мост',
      botUsername: BOT,
    });
    expect(result).toEqual({
      type: 'article',
      id: '0b5c3a1e7f0f4b8e9a511f0d2b3c4d5e',
      title: 'Выпуск №4 · Омск строит мост',
      description: 'Собрано в @podpiska_news_bot',
      input_message_content: {
        message_text: 'Выпуск №4 · Омск строит мост\n\nСобрано в @podpiska_news_bot',
        link_preview_options: { is_disabled: true },
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Читать газету',
              url: `https://t.me/podpiska_news_bot?startapp=issue_${ID}`,
            },
          ],
        ],
      },
    });
    expect(result.id.length).toBeLessThanOrEqual(64);
  });

  it('never uses a web_app button or a parse_mode', () => {
    const result = buildShareResult({
      issueId: ID,
      number: 1,
      headline: '<b>x</b>',
      botUsername: BOT,
    });
    expect(JSON.stringify(result)).not.toContain('web_app');
    expect(result.input_message_content).not.toHaveProperty('parse_mode');
    expect(result.title).toBe('Выпуск №1 · <b>x</b>');
  });

  it('drops a missing headline and truncates a long one', () => {
    expect(shareTitle(2, null)).toBe('Выпуск №2');
    expect(shareTitle(2, '   ')).toBe('Выпуск №2');
    const long = shareTitle(3, `${'д'.repeat(SHARE_HEADLINE_MAX + 50)}`);
    expect(long.startsWith('Выпуск №3 · ')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(long.slice('Выпуск №3 · '.length))).toHaveLength(SHARE_HEADLINE_MAX);
    expect(shareTitle(5, 'a\n\nb')).toBe('Выпуск №5 · a b');
  });
});

describe('parseStartParam', () => {
  it('accepts only issue_<uuid>', () => {
    expect(parseStartParam(`issue_${ID}`)).toBe(ID);
    expect(new URL(issueStartUrl(BOT, ID)).searchParams.get('startapp')).toBe(`issue_${ID}`);
  });

  it.each([
    null,
    undefined,
    '',
    ID,
    `issue_${ID.toUpperCase()}`,
    `issue_${ID}x`,
    `xissue_${ID}`,
    `issue_${ID.replaceAll('-', '')}`,
    'issue_------------------------------------',
    `issue_${ID}\n`,
    'issue_../../api/app/me',
  ])('rejects %j', (value) => {
    expect(parseStartParam(value)).toBeNull();
  });
});
