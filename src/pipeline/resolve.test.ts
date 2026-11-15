import { describe, expect, it } from 'vitest';

import draftFixture from './__fixtures__/issue-draft.json';
import { LeadUnsourcedError } from './errors';
import { resolveIssue, type ItemIndex, type PostRef } from './resolve';
import { issueDraftSchema, issueSchema, type IssueDraft } from './schema';

const period = { start: new Date('2026-11-14T21:00:00Z'), end: new Date('2026-11-15T18:00:00Z') };
const inPeriod = new Date('2026-11-15T08:00:00Z');

const channelsById: Record<number, { username: string; title: string }> = {
  1: { username: 'citynews', title: 'Городские новости' },
  2: { username: 'econ', title: 'Экономика региона' },
  3: { username: 'stranger', title: 'Чужой канал' },
};

const post = (id: number, channelId: number, publishedAt = inPeriod): [number, PostRef] => {
  const channel = channelsById[channelId];
  if (!channel) throw new Error('bad channel');
  return [
    id,
    {
      channelId,
      username: channel.username,
      channelTitle: channel.title,
      tgPostId: 1000 + id,
      publishedAt,
    },
  ];
};

const index: ItemIndex = {
  items: new Map<string, number[]>([
    ['i1', [1, 2]],
    ['i2', [3]],
    ['i3', [4]],
    ['i4', [5]],
    ['i5', [6]],
    ['i6', [7]],
    ['i7', [8]],
    ['i8', [9]],
    ['i9', [10]],
    ['i10', [11]],
    ['i11', [12]],
  ]),
  posts: new Map<number, PostRef>([
    post(1, 1),
    post(2, 2),
    post(3, 2),
    post(4, 2),
    post(5, 2),
    post(6, 1),
    post(7, 1),
    post(8, 1),
    post(9, 1),
    post(10, 1),
    post(11, 1, new Date('2026-11-10T08:00:00Z')),
    post(12, 3),
  ]),
};

const meta = { period, channelIds: new Set([1, 2]) };
const fixture = (): IssueDraft => issueDraftSchema.parse(structuredClone(draftFixture));

const allSources = (value: unknown): { postUrl: string; label: string }[] => {
  const found: { postUrl: string; label: string }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') {
      if ('postUrl' in node && 'label' in node)
        found.push(node as { postUrl: string; label: string });
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return found;
};

describe('resolveIssue', () => {
  it('builds post URLs from the index only and never from draft labels', () => {
    const { content } = resolveIssue(fixture(), index, meta);
    expect(content.lead.sources).toEqual([
      { channel: 'Городские новости', label: 'Мэрия', postUrl: 'https://t.me/citynews/1001' },
      { channel: 'Экономика региона', label: 'Мэрия', postUrl: 'https://t.me/econ/1002' },
      { channel: 'Экономика региона', label: 'Горсовет', postUrl: 'https://t.me/econ/1003' },
    ]);
    const json = JSON.stringify(content);
    expect(json).not.toContain('evil');
    for (const source of allSources(content)) {
      expect(source.postUrl).toMatch(/^https:\/\/t\.me\/(citynews|econ)\/\d+$/);
    }
  });

  it('drops unknown refs and leaves left without sources, and counts them', () => {
    const { content, dropped } = resolveIssue(fixture(), index, meta);
    expect(content.sections?.map((section) => section.rubric)).toEqual(['Технологии']);
    expect(dropped.refs).toBeGreaterThanOrEqual(1);
    expect(dropped.notes).toBeGreaterThanOrEqual(1);
  });

  it('rejects refs outside the period or the user channels', () => {
    const draft = fixture();
    draft.briefs = [
      { label: 'Старое', text: 'Вне периода.', sources: [{ ref: 'i10', label: 'x' }] },
      { label: 'Чужое', text: 'Чужой канал.', sources: [{ ref: 'i11', label: 'x' }] },
    ];
    const { content, dropped } = resolveIssue(draft, index, meta);
    expect(content.briefs).toBeUndefined();
    expect(dropped.refs).toBeGreaterThanOrEqual(2);
  });

  it('turns a feature section without article into grid and removes empty sections', () => {
    const { content } = resolveIssue(fixture(), index, meta);
    expect(content.sections).toHaveLength(1);
    expect(content.sections?.[0]?.layout).toBe('grid');
  });

  it('keeps an item only in its first note', () => {
    const { content, dropped } = resolveIssue(fixture(), index, meta);
    expect(content.sideSection?.stories.map((story) => story.headline)).toEqual([
      'Хоккеисты выиграли выездной матч',
    ]);
    expect(dropped.duplicates).toBe(1);
    // Facts and ears may cite the lead's item.
    expect(content.numberOfDay?.sources[0]?.postUrl).toBe('https://t.me/citynews/1001');
  });

  it('truncates slot counts', () => {
    const draft = fixture();
    draft.briefs = Array.from({ length: 12 }, (_, i) => ({
      label: `Б${i}`,
      text: `Бриф ${i}.`,
      sources: [{ ref: 'i8', label: 'x' }],
    }));
    const { content } = resolveIssue(draft, index, meta);
    expect(content.lead.facts).toHaveLength(3);
    // All briefs share one item: only the first survives the one-item-one-note rule.
    expect(content.briefs).toHaveLength(1);

    const many = fixture();
    many.events = Array.from({ length: 15 }, (_, i) => ({
      date: `${i + 1} декабря`,
      text: `Событие ${i}`,
      sources: [{ ref: 'i5', label: 'x' }],
    }));
    expect(resolveIssue(many, index, meta).content.events).toHaveLength(10);
  });

  it('does not let dropped overflow or rubric-less sections claim items', () => {
    const wide: ItemIndex = {
      items: new Map([
        ...index.items,
        ...Array.from({ length: 10 }, (_, i): [string, number[]] => [`b${i}`, [100 + i]]),
      ]),
      posts: new Map([...index.posts, ...Array.from({ length: 10 }, (_, i) => post(100 + i, 1))]),
    };
    const draft = fixture();
    draft.sideSection = null;
    draft.frontSection = null;
    draft.sections = [
      {
        rubric: '  ',
        subtitle: 'Без рубрики',
        layout: 'grid',
        article: null,
        stories: [{ headline: 'Заголовок', text: 'Текст.', sources: [{ ref: 'b9', label: 'x' }] }],
      },
    ];
    // Briefs 0-7 fill the limit; brief 8 overflows and must not claim b8.
    draft.briefs = Array.from({ length: 9 }, (_, i) => ({
      label: `Б${i}`,
      text: `Бриф ${i}.`,
      sources: [{ ref: `b${i}`, label: 'x' }],
    }));
    draft.curiosities = [
      { text: 'Курьёз из переполнения.', sources: [{ ref: 'b8', label: 'x' }] },
      { text: 'Курьёз из пустой рубрики.', sources: [{ ref: 'b9', label: 'x' }] },
    ];
    const { content, dropped } = resolveIssue(draft, wide, meta);
    expect(content.sections).toBeUndefined();
    expect(content.briefs).toHaveLength(8);
    expect(content.curiosities?.map((item) => item.text)).toEqual([
      'Курьёз из переполнения.',
      'Курьёз из пустой рубрики.',
    ]);
    expect(dropped.duplicates).toBe(0);
  });

  it('treats the window as (start, end]', () => {
    const edges: ItemIndex = {
      items: new Map([
        ['i1', [1]],
        ['i2', [2]],
        ['i3', [3]],
      ]),
      posts: new Map([post(1, 1), post(2, 1, period.start), post(3, 1, period.end)]),
    };
    const draft = fixture();
    const { content } = resolveIssue(
      {
        ...draft,
        lead: { ...draft.lead, facts: [], sources: [{ ref: 'i1', label: 'x' }] },
        weather: null,
        numberOfDay: null,
        frontSection: null,
        sideSection: null,
        sections: [],
        quote: null,
        curiosities: [],
        events: [],
        briefs: [
          { label: 'Старт', text: 'На границе старта.', sources: [{ ref: 'i2', label: 'x' }] },
          { label: 'Конец', text: 'На границе конца.', sources: [{ ref: 'i3', label: 'x' }] },
        ],
      },
      edges,
      meta,
    );
    expect(content.briefs?.map((brief) => brief.label)).toEqual(['Конец']);
  });

  it('builds lowercase post URLs for mixed-case usernames', () => {
    const mixed: ItemIndex = {
      items: new Map([['i1', [1]]]),
      posts: new Map([[1, { ...post(1, 1)[1], username: 'Om1_Omsk' }]]),
    };
    const draft = fixture();
    const { content } = resolveIssue(
      { ...draft, lead: { ...draft.lead, facts: [], sources: [{ ref: 'i1', label: 'x' }] } },
      mixed,
      meta,
    );
    expect(content.lead.sources[0]?.postUrl).toBe('https://t.me/om1_omsk/1001');
  });

  it('strips URLs from model text', () => {
    const draft = fixture();
    draft.lead.paragraphs = ['Подробности на https://t.me/evil/1 и t.me/evil/2 тут.'];
    const { content } = resolveIssue(draft, index, meta);
    expect(content.lead.paragraphs[0]).toBe('Подробности на и тут.');
  });

  it('throws LeadUnsourcedError when the lead has no valid source', () => {
    const draft = fixture();
    draft.lead.sources = [{ ref: 'i999', label: 'x' }];
    expect(() => resolveIssue(draft, index, meta)).toThrow(LeadUnsourcedError);
  });

  it('produces content that passes the issue schema', () => {
    const { content } = resolveIssue(fixture(), index, meta);
    const issue = {
      schemaVersion: 1,
      masthead: {
        number: 1,
        messages: 10,
        channels: 2,
        dateline: '15 ноября 2026',
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
      },
      ...content,
      colophon: 'Колофон.',
    };
    expect(issueSchema.safeParse(issue).success).toBe(true);
    expect(content.quote?.text).toBe('Дороги будут готовы к весне');
  });
});
