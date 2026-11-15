import { z } from 'zod';

// Draft = what the LLM returns. Kept flat and bound-free (no min/max, tuples or real unions)
// so the Gemini response schema stays small; slot guidance lives in the system prompt.
// Sources are digest item refs (e.g. "i17"), never URLs: code turns refs into post links.

const draftSource = z.object({ ref: z.string(), label: z.string() });
const draftSources = z.array(draftSource);

const draftValueNote = z.object({ value: z.string(), text: z.string(), sources: draftSources });
const draftStory = z.object({ headline: z.string(), text: z.string(), sources: draftSources });
const draftInverse = z.object({ kicker: z.string(), text: z.string(), sources: draftSources });
const draftArticle = z.object({
  headline: z.string(),
  deck: z.string(),
  paragraphs: z.array(z.string()),
  sources: draftSources,
  inverse: draftInverse.nullable(),
});

export const sectionLayouts = ['feature', 'grid'] as const;

export const issueDraftSchema = z.object({
  weather: draftValueNote.nullable(),
  numberOfDay: draftValueNote.nullable(),
  lead: z.object({
    kicker: z.string(),
    headline: z.string(),
    deck: z.string(),
    facts: z.array(draftValueNote),
    paragraphs: z.array(z.string()),
    sources: draftSources,
  }),
  frontSection: z
    .object({ rubric: z.string(), subtitle: z.string(), article: draftArticle })
    .nullable(),
  sideSection: z
    .object({ rubric: z.string(), subtitle: z.string(), stories: z.array(draftStory) })
    .nullable(),
  sections: z.array(
    z.object({
      rubric: z.string(),
      subtitle: z.string(),
      layout: z.enum(sectionLayouts),
      article: draftArticle.nullable(),
      stories: z.array(draftStory),
    }),
  ),
  briefs: z.array(z.object({ label: z.string(), text: z.string(), sources: draftSources })),
  quote: z.object({ text: z.string(), author: z.string(), sources: draftSources }).nullable(),
  curiosities: z.array(z.object({ text: z.string(), sources: draftSources })),
  events: z.array(z.object({ date: z.string(), text: z.string(), sources: draftSources })),
});

export type IssueDraft = z.infer<typeof issueDraftSchema>;
export type DraftSource = z.infer<typeof draftSource>;

// Resolved issue = content_json. Every leaf carries ≥1 source with a code-built post URL.

export const ISSUE_SCHEMA_VERSION = 1;

const postUrlSchema = z
  .url({ protocol: /^https$/, hostname: /^t\.me$/ })
  .regex(/^https:\/\/t\.me\/[a-z0-9_]+\/\d+$/);

export const sourceSchema = z.object({
  channel: z.string().min(1),
  label: z.string().min(1),
  postUrl: postUrlSchema,
});
const sources = z.array(sourceSchema).min(1);

const text = z.string().min(1);
const valueNote = z.object({ value: text, text, sources });
const story = z.object({ headline: text, text, sources });
const article = z.object({
  headline: text,
  deck: z.string(),
  paragraphs: z.array(text).min(1),
  sources,
  inverse: z.object({ kicker: text, text, sources }).optional(),
});

export const issueSchema = z.object({
  schemaVersion: z.literal(ISSUE_SCHEMA_VERSION),
  masthead: z.object({
    number: z.number().int().positive(),
    messages: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
    dateline: text,
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
  }),
  weather: valueNote.optional(),
  numberOfDay: valueNote.optional(),
  lead: z.object({
    kicker: z.string(),
    headline: text,
    deck: z.string(),
    facts: z.array(valueNote),
    paragraphs: z.array(text).min(1),
    sources,
  }),
  frontSection: z.object({ rubric: text, subtitle: z.string(), article }).optional(),
  sideSection: z
    .object({ rubric: text, subtitle: z.string(), stories: z.array(story).min(1) })
    .optional(),
  sections: z
    .array(
      z.object({
        rubric: text,
        subtitle: z.string(),
        layout: z.enum(sectionLayouts),
        article: article.optional(),
        stories: z.array(story),
      }),
    )
    .optional(),
  briefs: z.array(z.object({ label: z.string(), text, sources })).optional(),
  quote: z.object({ text, author: z.string(), sources }).optional(),
  curiosities: z.array(z.object({ text, sources })).optional(),
  events: z.array(z.object({ date: text, text, sources })).optional(),
  colophon: text,
});

export type Issue = z.infer<typeof issueSchema>;
export type IssueSource = z.infer<typeof sourceSchema>;
export type IssueContent = Omit<Issue, 'schemaVersion' | 'masthead' | 'colophon'>;
