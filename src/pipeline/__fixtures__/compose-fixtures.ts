import type { StoredDigest } from '../digest-schema';
import type { IssueDraft } from '../schema';
import { FakeDigestStore, FakeIssueStore } from './fakes';

export const now = new Date('2026-11-15T15:00:00Z');
export const day = '2026-11-15';

export const channels = [
  { id: 1, username: 'citynews', title: 'Городские новости' },
  { id: 2, username: 'econ', title: null },
];

const digest = (postIds: number[][]): StoredDigest => ({
  version: 1,
  items: postIds.map((ids, i) => ({
    title: `Новость ${i + 1}`,
    summary: `Пересказ ${i + 1}`,
    importance: 3,
    topics: [],
    postIds: ids,
  })),
});

export function seedStores(): { digests: FakeDigestStore; issues: FakeIssueStore } {
  const digests = new FakeDigestStore();
  const issues = new FakeIssueStore();
  digests.digests.set(`1:${day}`, {
    channelId: 1,
    day,
    summary: digest([[101], [102]]),
    model: 'm',
    inputHash: 'h',
    computedAt: now,
  });
  digests.digests.set(`2:${day}`, {
    channelId: 2,
    day,
    summary: digest([[201]]),
    model: 'm',
    inputHash: 'h',
    computedAt: now,
  });
  issues.channels = channels;
  issues.postsMeta = [
    { id: 101, channelId: 1, tgPostId: 11, publishedAt: new Date('2026-11-15T06:00:00Z') },
    { id: 102, channelId: 1, tgPostId: 12, publishedAt: new Date('2026-11-15T07:00:00Z') },
    { id: 201, channelId: 2, tgPostId: 21, publishedAt: new Date('2026-11-15T08:00:00Z') },
  ];
  issues.counts = { messages: 7, channels: 2 };
  return { digests, issues };
}

export const validDraft = (): IssueDraft => ({
  weather: null,
  numberOfDay: null,
  lead: {
    kicker: 'Экономика · бюджет',
    headline: 'Город принял бюджет',
    deck: 'Расходы на дороги вырастут.',
    facts: [],
    paragraphs: ['Горсовет одобрил бюджет.'],
    sources: [
      { ref: 'i1', label: 'Мэрия' },
      { ref: 'i3', label: 'Минфин' },
    ],
  },
  frontSection: null,
  sideSection: null,
  sections: [],
  briefs: [{ label: 'Город', text: 'Короткая новость.', sources: [{ ref: 'i2', label: 'Мэрия' }] }],
  quote: null,
  curiosities: [],
  events: [],
});
