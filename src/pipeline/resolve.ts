import { postUrl } from '@/collector';

import { LeadUnsourcedError } from './errors';
import {
  issueSchema,
  type DraftSource,
  type IssueContent,
  type IssueDraft,
  type IssueSource,
} from './schema';

export interface PostRef {
  channelId: number;
  username: string;
  channelTitle: string;
  tgPostId: number;
  publishedAt: Date;
}

export interface ItemIndex {
  /** Digest item ref (e.g. "i17") → posts.id values. */
  items: ReadonlyMap<string, readonly number[]>;
  posts: ReadonlyMap<number, PostRef>;
}

export interface ResolveMeta {
  period: { start: Date; end: Date };
  channelIds: ReadonlySet<number>;
}

export interface DroppedStats {
  /** Refs that are unknown or point only to posts outside the user's channels/period. */
  refs: number;
  /** Leaves removed because no valid source was left. */
  notes: number;
  /** Leaves removed because their items were already used by an earlier note. */
  duplicates: number;
}

export interface ResolveResult {
  content: IssueContent;
  dropped: DroppedStats;
}

const LIMITS = {
  facts: 3,
  briefs: 8,
  curiosities: 4,
  events: 10,
  sections: 5,
  stories: 6,
  sourcesPerNote: 4,
};
const MAX_LABEL = 60;

const URL_RE = /\b(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)\S*/gi;

/** Model text never carries links into the issue: links are built from refs only. */
const clean = (value: string): string =>
  value
    .replace(URL_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

const normalizeRef = (ref: string): string => ref.trim().toLowerCase();

const take = <T>(list: readonly T[], max: number): T[] => list.slice(0, max);

/**
 * Resolves entries in order until `max` survive. Entries past the limit are never resolved,
 * so overflow the issue drops cannot claim news items.
 */
const resolveUpTo = <T, R>(
  list: readonly T[],
  max: number,
  fn: (entry: T) => R | undefined,
): R[] => {
  const out: R[] = [];
  for (const entry of list) {
    if (out.length >= max) break;
    const value = fn(entry);
    if (value !== undefined) out.push(value);
  }
  return out;
};

const presentArray = <T>(list: readonly T[]): T[] | undefined =>
  list.length > 0 ? [...list] : undefined;

const cleanParagraphs = (paragraphs: readonly string[]): string[] =>
  paragraphs.map(clean).filter((p) => p !== '');

type DraftStory = NonNullable<IssueDraft['sideSection']>['stories'][number];
type DraftArticle = NonNullable<IssueDraft['frontSection']>['article'];

const contentSchema = issueSchema.omit({ schemaVersion: true, masthead: true, colophon: true });

export function resolveIssue(
  draft: IssueDraft,
  index: ItemIndex,
  meta: ResolveMeta,
): ResolveResult {
  const dropped: DroppedStats = { refs: 0, notes: 0, duplicates: 0 };
  const used = new Set<string>();
  const start = meta.period.start.getTime();
  const end = meta.period.end.getTime();

  const validPosts = (ref: string): PostRef[] => {
    const ids = index.items.get(ref) ?? [];
    return ids.flatMap((id) => {
      const post = index.posts.get(id);
      if (post === undefined || !meta.channelIds.has(post.channelId)) return [];
      const at = post.publishedAt.getTime();
      // (start, end]: a post exactly at the previous issue's end belongs to that issue.
      return at > start && at <= end ? [post] : [];
    });
  };

  /**
   * Turns draft sources into post links. With `exclusive`, refs already used by an earlier
   * note are skipped (one news item, one note); with `consume`, this note claims its refs.
   */
  const resolveSources = (
    draftSources: readonly DraftSource[],
    { exclusive, consume }: { exclusive: boolean; consume: boolean },
  ): { sources: IssueSource[]; duplicate: boolean } => {
    const out = new Map<string, IssueSource>();
    const refs: string[] = [];
    let duplicate = false;
    for (const source of draftSources) {
      const ref = normalizeRef(source.ref);
      const posts = validPosts(ref);
      if (posts.length === 0) {
        dropped.refs += 1;
        continue;
      }
      if (exclusive && used.has(ref) && !refs.includes(ref)) {
        duplicate = true;
        continue;
      }
      refs.push(ref);
      const rawLabel = clean(source.label).slice(0, MAX_LABEL);
      for (const post of posts) {
        const url = postUrl(post.username, post.tgPostId);
        if (!out.has(url)) {
          out.set(url, {
            channel: post.channelTitle,
            label: rawLabel || post.channelTitle,
            postUrl: url,
          });
        }
      }
    }
    const sources = take([...out.values()], LIMITS.sourcesPerNote);
    if (consume && sources.length > 0) {
      for (const ref of refs) used.add(ref);
    }
    return { sources, duplicate };
  };

  /** Returns sources or undefined (and counts the dropped leaf). */
  const leaf = (
    draftSources: readonly DraftSource[],
    texts: readonly string[],
    mode: { exclusive: boolean; consume: boolean },
  ): IssueSource[] | undefined => {
    if (texts.some((value) => value === '')) {
      dropped.notes += 1;
      return undefined;
    }
    const { sources, duplicate } = resolveSources(draftSources, mode);
    if (sources.length === 0) {
      if (duplicate) dropped.duplicates += 1;
      else dropped.notes += 1;
      return undefined;
    }
    return sources;
  };

  const note = { exclusive: true, consume: true };
  const shared = { exclusive: false, consume: false };

  const valueNote = (draftNote: { value: string; text: string; sources: DraftSource[] } | null) => {
    if (draftNote === null) return undefined;
    const value = clean(draftNote.value);
    const text = clean(draftNote.text);
    const sources = leaf(draftNote.sources, [value, text], shared);
    return sources && { value, text, sources };
  };

  const story = (draftStory: DraftStory) => {
    const headline = clean(draftStory.headline);
    const text = clean(draftStory.text);
    const sources = leaf(draftStory.sources, [headline, text], note);
    return sources && { headline, text, sources };
  };

  const article = (draftArticle: DraftArticle | null) => {
    if (draftArticle === null) return undefined;
    const headline = clean(draftArticle.headline);
    const paragraphs = cleanParagraphs(draftArticle.paragraphs);
    const sources = leaf(draftArticle.sources, [headline, paragraphs.length > 0 ? 'ok' : ''], note);
    if (sources === undefined) return undefined;
    let inverse;
    if (draftArticle.inverse !== null) {
      const kicker = clean(draftArticle.inverse.kicker);
      const text = clean(draftArticle.inverse.text);
      const inverseSources = leaf(draftArticle.inverse.sources, [kicker, text], shared);
      inverse = inverseSources && { kicker, text, sources: inverseSources };
    }
    return {
      headline,
      deck: clean(draftArticle.deck),
      paragraphs,
      sources,
      ...(inverse === undefined ? {} : { inverse }),
    };
  };

  // Lead first: it claims its items before any other note.
  const leadHeadline = clean(draft.lead.headline);
  const leadParagraphs = cleanParagraphs(draft.lead.paragraphs);
  const leadSources = resolveSources(draft.lead.sources, note).sources;
  if (leadSources.length === 0 || leadHeadline === '' || leadParagraphs.length === 0) {
    throw new LeadUnsourcedError(
      leadSources.length === 0
        ? undefined
        : 'lead_unsourced: the lead has no headline or paragraphs',
    );
  }
  const lead = {
    kicker: clean(draft.lead.kicker),
    headline: leadHeadline,
    deck: clean(draft.lead.deck),
    facts: resolveUpTo(draft.lead.facts, LIMITS.facts, valueNote),
    paragraphs: leadParagraphs,
    sources: leadSources,
  };

  // Rubrics are checked before notes are resolved: a dropped section must not claim items.
  let frontSection: IssueContent['frontSection'];
  const frontRubric = draft.frontSection === null ? '' : clean(draft.frontSection.rubric);
  if (draft.frontSection !== null && frontRubric !== '') {
    const frontArticle = article(draft.frontSection.article);
    if (frontArticle !== undefined) {
      frontSection = {
        rubric: frontRubric,
        subtitle: clean(draft.frontSection.subtitle),
        article: frontArticle,
      };
    }
  }

  let sideSection: IssueContent['sideSection'];
  const sideRubric = draft.sideSection === null ? '' : clean(draft.sideSection.rubric);
  if (draft.sideSection !== null && sideRubric !== '') {
    const stories = resolveUpTo(draft.sideSection.stories, LIMITS.stories, story);
    if (stories.length > 0) {
      sideSection = { rubric: sideRubric, subtitle: clean(draft.sideSection.subtitle), stories };
    }
  }

  const sections = resolveUpTo(draft.sections, LIMITS.sections, (section) => {
    const rubric = clean(section.rubric);
    if (rubric === '') return undefined;
    const sectionArticle = article(section.article);
    const stories = resolveUpTo(section.stories, LIMITS.stories, story);
    if (sectionArticle === undefined && stories.length === 0) return undefined;
    const layout =
      section.layout === 'feature' && sectionArticle !== undefined ? 'feature' : 'grid';
    return {
      rubric,
      subtitle: clean(section.subtitle),
      layout,
      ...(sectionArticle === undefined ? {} : { article: sectionArticle }),
      stories,
    } as const;
  });

  const briefs = resolveUpTo(draft.briefs, LIMITS.briefs, (brief) => {
    const label = clean(brief.label);
    const text = clean(brief.text);
    const sources = leaf(brief.sources, [text], note);
    return sources && { label, text, sources };
  });

  let quote: IssueContent['quote'];
  if (draft.quote !== null) {
    const text = clean(draft.quote.text)
      .replace(/^[«"„]+|[»"“]+$/g, '')
      .trim();
    const author = clean(draft.quote.author);
    const sources = leaf(draft.quote.sources, [text], shared);
    quote = sources && { text, author, sources };
  }

  const curiosities = resolveUpTo(draft.curiosities, LIMITS.curiosities, (item) => {
    const text = clean(item.text);
    const sources = leaf(item.sources, [text], note);
    return sources && { text, sources };
  });

  const events = resolveUpTo(draft.events, LIMITS.events, (event) => {
    const date = clean(event.date);
    const text = clean(event.text);
    const sources = leaf(event.sources, [date, text], shared);
    return sources && { date, text, sources };
  });

  const weather = valueNote(draft.weather);
  const numberOfDay = valueNote(draft.numberOfDay);

  const content: IssueContent = {
    ...(weather === undefined ? {} : { weather }),
    ...(numberOfDay === undefined ? {} : { numberOfDay }),
    lead,
    ...(frontSection === undefined ? {} : { frontSection }),
    ...(sideSection === undefined ? {} : { sideSection }),
    ...(sections.length === 0 ? {} : { sections }),
    ...(presentArray(briefs) === undefined ? {} : { briefs }),
    ...(quote === undefined ? {} : { quote }),
    ...(presentArray(curiosities) === undefined ? {} : { curiosities }),
    ...(presentArray(events) === undefined ? {} : { events }),
  };

  return { content: contentSchema.parse(content), dropped };
}
