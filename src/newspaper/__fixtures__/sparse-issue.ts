import type { Issue as IssueDoc, IssueSource } from '@/pipeline/schema';

const src = (
  channel: string,
  id: number,
  label = channel,
  slug = 'sparse_channel',
): IssueSource => ({
  channel,
  label,
  postUrl: `https://t.me/${slug}/${id}`,
});

/** The thinnest valid issue: a lead with one short paragraph and nothing else. */
export const minimalIssue: IssueDoc = {
  schemaVersion: 1,
  masthead: {
    number: 2,
    messages: 1,
    channels: 1,
    dateline: '16 ноября 2026',
    periodStart: '2026-11-15T21:00:00.000Z',
    periodEnd: '2026-11-16T21:00:00.000Z',
  },
  lead: {
    kicker: '',
    headline: 'Тихий день',
    deck: '',
    facts: [],
    paragraphs: ['Ничего не произошло.'],
    sources: [src('Тихий канал', 1)],
  },
  colophon: 'Выпуск собран из одного поста.',
};

const fact = (value: string, id: number) => ({
  value,
  text: `факт ${value}`,
  sources: [src('Тихий канал', id)],
});

export const oneFactIssue: IssueDoc = {
  ...minimalIssue,
  lead: { ...minimalIssue.lead, facts: [fact('1', 11)] },
};

export const twoFactsIssue: IssueDoc = {
  ...minimalIssue,
  lead: { ...minimalIssue.lead, facts: [fact('1', 11), fact('2', 12)] },
};

export const fourFactsIssue: IssueDoc = {
  ...minimalIssue,
  lead: {
    ...minimalIssue.lead,
    facts: [fact('1', 11), fact('2', 12), fact('3', 13), fact('4', 14)],
  },
};

export const onlyWeatherIssue: IssueDoc = {
  ...minimalIssue,
  weather: { value: 'Ясно', text: 'днём +3', sources: [src('Погода', 21, 'Погода', 'weather_ch')] },
};

export const featureWithoutArticleIssue: IssueDoc = {
  ...minimalIssue,
  sections: [
    {
      rubric: 'Без статьи',
      subtitle: '',
      layout: 'feature',
      stories: [
        { headline: 'Первая', text: 'Текст первой.', sources: [src('Тихий канал', 31)] },
        { headline: 'Вторая', text: 'Текст второй.', sources: [src('Тихий канал', 32)] },
      ],
    },
  ],
};

export const emptySectionIssue: IssueDoc = {
  ...minimalIssue,
  sections: [{ rubric: 'Пустая', subtitle: 'ничего', layout: 'grid', stories: [] }],
};

export const gridWithArticleIssue: IssueDoc = {
  ...minimalIssue,
  sections: [
    {
      rubric: 'Сетка со статьёй',
      subtitle: '',
      layout: 'grid',
      article: {
        headline: 'Статья в сетке',
        deck: '',
        paragraphs: ['Один абзац.'],
        sources: [src('Тихий канал', 41)],
      },
      stories: [{ headline: 'Заметка', text: 'Текст.', sources: [src('Тихий канал', 42)] }],
    },
  ],
};

/** Mixed byline rules: labels != channel, repeated labels, plain multi-post channel, duplicate URL. */
export const multiChannelIssue: IssueDoc = {
  ...minimalIssue,
  lead: {
    ...minimalIssue.lead,
    sources: [
      src('КОНТЕКСТ', 51, 'Белый дом', 'kontext_channel'),
      src('КОНТЕКСТ', 52, 'Кремль', 'kontext_channel'),
      src('Топор Live', 53, 'Al Jazeera', 'toporlive'),
      src('Топор Live', 54, 'Al Jazeera', 'toporlive'),
      src('XOR', 55, 'XOR', 'xor_journal'),
      src('XOR', 56, 'XOR', 'xor_journal'),
      src('XOR', 56, 'XOR', 'xor_journal'),
    ],
  },
  briefs: [{ label: '', text: 'Бриф без метки.', sources: [src('XOR', 57, 'XOR', 'xor_journal')] }],
};

export const sparseIssues = {
  minimal: minimalIssue,
  oneFact: oneFactIssue,
  twoFacts: twoFactsIssue,
  fourFacts: fourFactsIssue,
  onlyWeather: onlyWeatherIssue,
  featureWithoutArticle: featureWithoutArticleIssue,
  emptySection: emptySectionIssue,
  gridWithArticle: gridWithArticleIssue,
  multiChannel: multiChannelIssue,
} as const satisfies Record<string, IssueDoc>;
