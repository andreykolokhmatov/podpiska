import { describe, expect, it } from 'vitest';

import { texts as botTexts } from '@/bot/texts';
import { apiErrorCodes, issueErrorCodes } from '@/miniapp/contract';

import { appendInterest } from './interests';
import { apiErrorText, errorText, issueErrorText, t } from './texts';

describe('error copy', () => {
  it.each([...apiErrorCodes, 'network' as const])('api %s has Russian copy', (code) => {
    expect(apiErrorText[code]).toMatch(/[а-яё]/i);
  });

  it.each(issueErrorCodes)('issue %s has Russian copy', (code) => {
    expect(issueErrorText[code]).toMatch(/[а-яё]/i);
  });

  it('has no copy for unknown codes', () => {
    expect(Object.keys(apiErrorText).sort()).toEqual([...apiErrorCodes, 'network'].sort());
    expect(Object.keys(issueErrorText).sort()).toEqual([...issueErrorCodes].sort());
  });

  it('channel errors share the bot wording', () => {
    expect(errorText('private')).toBe(botTexts.private);
    expect(errorText('invalid')).toBe(botTexts.invalid);
    expect(errorText('channel_not_found')).toBe(botTexts.notFound);
    expect(errorText('retry_later')).toBe(botTexts.retryLater);
    expect(errorText('channel_limit', 20)).toBe(botTexts.limit(20));
  });
});

describe('appendInterest', () => {
  it('starts, appends with a comma, skips duplicates', () => {
    expect(appendInterest('', 'Без спорта')).toBe('Без спорта');
    expect(appendInterest('  ', 'Без спорта')).toBe('Без спорта');
    expect(appendInterest('Новости Омска', 'Без спорта')).toBe('Новости Омска, без спорта');
    expect(appendInterest('Новости Омска.', 'Без спорта')).toBe('Новости Омска. без спорта');
    expect(appendInterest('Новости, без спорта', 'Без спорта')).toBe('Новости, без спорта');
  });
});

describe('dash rule', () => {
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return strings((value as (n: number) => unknown)(2));
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  };

  it('UI copy uses the en dash only', () => {
    const all = strings([t, apiErrorText, issueErrorText]);
    expect(all.length).toBeGreaterThan(50);
    for (const text of all) expect(text).not.toContain('—');
  });

  it('archive delete and issue actions copy', () => {
    expect(t.archive.deleteTitle(4)).toBe('Удалить выпуск №\u00A04?');
    expect(t.archive.deleteText).toBe(
      'Выпуск пропадёт из архива, ссылка на него перестанет открываться.',
    );
    expect(t.issueActions.share).toBe('Поделиться');
    expect(t.issueActions.pdf).toBe('Скачать PDF');
  });

  it('schedule copy', () => {
    expect(t.schedule.frequencies).toEqual({
      1: 'Каждый день',
      3: 'Раз в 3 дня',
      7: 'Раз в неделю',
    });
    expect(t.schedule.pausedNote).toBe(
      'Приостановлено: последние выпуски остались непрочитанными или бот не смог их прислать. Включите, чтобы продолжить.',
    );
    expect(t.schedule.timeZone('Омск (UTC+6)')).toBe('Часовой пояс: Омск (UTC+6)');
    expect(t.hub.buildNow).toBe('Собрать сейчас');
  });
});
