import { describe, expect, it } from 'vitest';

import { texts as botTexts } from '@/bot/texts';
import { apiErrorCodes, issueErrorCodes } from '@/miniapp/contract';

import { appendInterest } from './interests';
import { apiErrorText, errorText, issueErrorText } from './texts';

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
