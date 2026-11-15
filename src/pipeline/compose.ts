import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';

import type { LlmStage } from '@/llm/client';
import { addUsage, emptyUsage, fromModelUsage, type TokenUsage } from '@/llm/usage';

import { formatDateline, type Period } from './day';
import { storedDigestSchema, type StoredDigest } from './digest-schema';
import { LeadUnsourcedError, NoNewsError } from './errors';
import {
  buildComposePrompt,
  EDITORIAL_SYSTEM_PROMPT,
  trimItems,
  type ComposeItem,
} from './prompts';
import { resolveIssue, type DroppedStats, type ItemIndex, type PostRef } from './resolve';
import {
  ISSUE_SCHEMA_VERSION,
  issueDraftSchema,
  issueSchema,
  type Issue,
  type IssueContent,
} from './schema';
import type { DigestStore, IssueStore, UserChannelRow } from './store';

const COMPOSE_TIMEOUT_MS = 240_000;
const COMPOSE_ATTEMPTS = 2;

export interface ComposeDeps {
  digests: Pick<DigestStore, 'getDigest'>;
  issues: Pick<IssueStore, 'getPostsMeta' | 'periodCounts'>;
  smart: LlmStage;
}

export interface ComposeInput {
  userId: number;
  channels: readonly UserChannelRow[];
  period: Period;
  interests: string | null;
}

export interface ComposedIssue {
  /** Full content_json once the issue number is known (assigned at ready). */
  build: (number: number) => Issue;
  content: IssueContent;
  dropped: DroppedStats;
  usage: TokenUsage;
  attempts: number;
  items: number;
  trimmed: boolean;
  messages: number;
  channels: number;
}

const channelTitle = (channel: UserChannelRow): string => channel.title ?? `@${channel.username}`;

async function loadItems(
  deps: ComposeDeps,
  input: ComposeInput,
): Promise<{ items: ComposeItem[]; index: ItemIndex }> {
  const candidates: { channel: UserChannelRow; item: StoredDigest['items'][number] }[] = [];
  for (const channel of input.channels) {
    for (const day of input.period.days) {
      const row = await deps.digests.getDigest(channel.id, day);
      const parsed = row && storedDigestSchema.safeParse(row.summary);
      if (!parsed?.success) continue;
      for (const item of parsed.data.items) candidates.push({ channel, item });
    }
  }

  const byId = new Map(input.channels.map((channel) => [channel.id, channel]));
  const meta = await deps.issues.getPostsMeta([
    ...new Set(candidates.flatMap(({ item }) => item.postIds)),
  ]);
  const start = input.period.start.getTime();
  const end = input.period.end.getTime();
  const posts = new Map<number, PostRef>();
  for (const post of meta) {
    const channel = byId.get(post.channelId);
    if (channel === undefined) continue;
    posts.set(post.id, {
      channelId: post.channelId,
      username: channel.username,
      channelTitle: channelTitle(channel),
      tgPostId: post.tgPostId,
      publishedAt: post.publishedAt,
    });
  }

  // A touched day may start before the window: only items with a post inside it are offered.
  const inWindow = (id: number): boolean => {
    const at = posts.get(id)?.publishedAt.getTime();
    return at !== undefined && at > start && at <= end;
  };
  const items: ComposeItem[] = [];
  const itemPosts = new Map<string, number[]>();
  for (const { channel, item } of candidates) {
    if (!item.postIds.some(inWindow)) continue;
    const ref = `i${items.length + 1}`;
    items.push({
      ref,
      channelId: channel.id,
      channelTitle: channelTitle(channel),
      importance: item.importance,
      title: item.title,
      summary: item.summary,
    });
    itemPosts.set(ref, item.postIds);
  }
  return { items, index: { items: itemPosts, posts } };
}

const isRetryable = (error: unknown): boolean =>
  NoObjectGeneratedError.isInstance(error) ||
  NoOutputGeneratedError.isInstance(error) ||
  error instanceof LeadUnsourcedError;

export function colophonFor(dateline: string): string {
  return `Выпуск собран из постов в Telegram-каналах, на которые подписан читатель, за ${dateline} года. Тексты пересказаны; позиции сторон по политическим темам переданы как их заявления, без оценки редакции.`;
}

export async function composeIssue(deps: ComposeDeps, input: ComposeInput): Promise<ComposedIssue> {
  const { items: allItems, index } = await loadItems(deps, input);
  if (allItems.length === 0) {
    throw new NoNewsError();
  }
  const { items, trimmed } = trimItems(allItems);
  const dateline = formatDateline(input.period.days);
  const channelIds = new Set(input.channels.map((channel) => channel.id));

  let usage = emptyUsage();
  let retryNote: string | undefined;
  let resolved: ReturnType<typeof resolveIssue> | undefined;
  let attempts = 0;
  while (resolved === undefined) {
    attempts += 1;
    try {
      const result = await generateText({
        model: deps.smart.model,
        providerOptions: deps.smart.providerOptions,
        ...(deps.smart.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: deps.smart.maxOutputTokens }),
        system: EDITORIAL_SYSTEM_PROMPT,
        prompt: buildComposePrompt({
          interests: input.interests,
          dateline,
          items,
          trimmed,
          ...(retryNote === undefined ? {} : { retryNote }),
        }),
        output: Output.object({ schema: issueDraftSchema }),
        maxRetries: 2,
        timeout: COMPOSE_TIMEOUT_MS,
      });
      usage = addUsage(usage, fromModelUsage(result.usage));
      resolved = resolveIssue(result.output, index, { period: input.period, channelIds });
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error) && error.usage !== undefined) {
        usage = addUsage(usage, fromModelUsage(error.usage));
      }
      if (attempts >= COMPOSE_ATTEMPTS || !isRetryable(error)) throw error;
      retryNote =
        error instanceof LeadUnsourcedError
          ? 'у главной новости нет ни одного ref из входа — укажи реальные ref'
          : 'ответ не соответствовал JSON-схеме — верни полный объект строго по схеме';
    }
  }

  const counts = await deps.issues.periodCounts(input.userId, input.period);
  const content = resolved.content;
  const build = (number: number): Issue =>
    issueSchema.parse({
      schemaVersion: ISSUE_SCHEMA_VERSION,
      masthead: {
        number,
        messages: counts.messages,
        channels: counts.channels,
        dateline,
        periodStart: input.period.start.toISOString(),
        periodEnd: input.period.end.toISOString(),
      },
      ...content,
      colophon: colophonFor(dateline),
    });
  // Fail before the issue is marked ready if the assembled document is invalid.
  build(1);

  return {
    build,
    content,
    dropped: resolved.dropped,
    usage,
    attempts,
    items: items.length,
    trimmed,
    messages: counts.messages,
    channels: counts.channels,
  };
}
