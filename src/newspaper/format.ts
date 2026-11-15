import { POST_URL_RE, type Issue as IssueDoc, type IssueSource } from '@/pipeline/schema';

type Section = NonNullable<IssueDoc['sections']>[number];
type Story = Section['stories'][number];

export type PluralForms = readonly [one: string, few: string, many: string];

/** Russian plural form for n: 1 сообщение, 2 сообщения, 5 сообщений, 11 сообщений, 21 сообщение. */
export function pluralRu(n: number, forms: PluralForms): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const MESSAGE_FORMS: PluralForms = ['сообщение', 'сообщения', 'сообщений'];
export const CHANNEL_FORMS: PluralForms = ['канал', 'канала', 'каналов'];

export function countLine(messages: number, channels: number): string {
  return `${messages} ${pluralRu(messages, MESSAGE_FORMS)} · ${channels} ${pluralRu(channels, CHANNEL_FORMS)}`;
}

export function isPostUrl(value: string): boolean {
  return POST_URL_RE.test(value);
}

export interface BylineLink {
  text: string;
  href: string;
}

export interface BylineGroup {
  /** Channel name shown before the links ("КАНАЛ: a · b"), or null when the link text is the channel. */
  prefix: string | null;
  links: BylineLink[];
}

/**
 * Groups sources by channel (first-appearance order), drops duplicate and non-post URLs.
 * - one source, label == channel  → link "Канал"
 * - several, all labels == channel → "Канал: 1 · 2"
 * - any label != channel          → "Канал: label · label"; a repeated label becomes its ordinal "· 2"
 */
export function groupSources(sources: readonly IssueSource[]): BylineGroup[] {
  const seen = new Set<string>();
  const byChannel = new Map<string, IssueSource[]>();
  for (const source of sources) {
    if (!isPostUrl(source.postUrl) || seen.has(source.postUrl)) continue;
    seen.add(source.postUrl);
    const list = byChannel.get(source.channel);
    if (list) list.push(source);
    else byChannel.set(source.channel, [source]);
  }

  return [...byChannel].map(([channel, list]) => {
    const plain = list.every((s) => s.label === channel);
    if (plain) {
      if (list.length === 1)
        return { prefix: null, links: [{ text: channel, href: list[0]!.postUrl }] };
      return {
        prefix: channel,
        links: list.map((s, i) => ({ text: String(i + 1), href: s.postUrl })),
      };
    }
    const counts = new Map<string, number>();
    return {
      prefix: channel,
      links: list.map((s) => {
        const n = (counts.get(s.label) ?? 0) + 1;
        counts.set(s.label, n);
        return { text: n === 1 ? s.label : String(n), href: s.postUrl };
      }),
    };
  });
}

/** Separator between channel groups: "; " once any group carries a prefix, else " · ". */
export function groupSeparator(groups: readonly BylineGroup[]): string {
  return groups.some((g) => g.prefix !== null) ? '; ' : ' · ';
}

export function visibleFacts<T>(facts: readonly T[]): T[] {
  return facts.slice(0, 3);
}

export const FEATURE_LIST_SIZE = 3;

export function splitFeatureStories(stories: readonly Story[]): { list: Story[]; extra: Story[] } {
  return { list: stories.slice(0, FEATURE_LIST_SIZE), extra: stories.slice(FEATURE_LIST_SIZE) };
}

export function isSectionEmpty(section: Section): boolean {
  return section.article === undefined && section.stories.length === 0;
}

/** A feature needs its article; without one the section falls back to the grid. */
export function effectiveLayout(section: Section): Section['layout'] {
  return section.layout === 'feature' && section.article !== undefined ? 'feature' : 'grid';
}

/** React key for a content unit: first post link + text, index-suffixed so duplicates never collide. */
export function unitKey(
  unit: { sources: readonly IssueSource[] },
  text: string,
  index: number,
): string {
  return `${unit.sources[0]?.postUrl ?? ''}|${text}|${index}`;
}
