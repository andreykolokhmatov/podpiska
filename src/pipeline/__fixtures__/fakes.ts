import { MockLanguageModelV4 } from 'ai/test';

import type { LlmStage } from '@/llm/client';

import type {
  DayPost,
  DigestRow,
  DigestStore,
  IssueRecord,
  IssueStore,
  PostMeta,
  UserChannelRow,
} from '../store';
import { StatusTransitionError } from '../errors';

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

export const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

export const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'STOP' },
  usage,
  warnings: [],
});

export const promptText = (options: CallOptions): string =>
  options.prompt
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');

/** A stage whose model answers each call with `respond(promptText)`. */
export function mockStage(
  id: string,
  respond: (prompt: string, call: number) => string | Error,
): { stage: LlmStage; model: MockLanguageModelV4 } {
  let call = 0;
  const model = new MockLanguageModelV4({
    modelId: id,
    doGenerate: async (options) => {
      call += 1;
      const answer = respond(promptText(options), call);
      if (answer instanceof Error) throw answer;
      return textResult(answer);
    },
  });
  return { stage: { model, id, providerOptions: {} }, model };
}

export class FakeDigestStore implements DigestStore {
  readonly posts = new Map<number, DayPost[]>();
  readonly digests = new Map<string, DigestRow>();
  saves = 0;

  async getDigest(channelId: number, day: string) {
    return this.digests.get(`${channelId}:${day}`);
  }
  async saveDigest(row: DigestRow) {
    this.saves += 1;
    this.digests.set(`${row.channelId}:${row.day}`, row);
  }
  async getChannelDayPosts(channelId: number, range: { start: Date; end: Date }) {
    return (this.posts.get(channelId) ?? [])
      .filter((post) => post.publishedAt >= range.start && post.publishedAt < range.end)
      .filter((post) => post.text.trim() !== '')
      .sort((a, b) => a.tgPostId - b.tgPostId);
  }
}

export class FakeIssueStore implements IssueStore {
  readonly issues = new Map<
    string,
    IssueRecord & {
      number: number | null;
      error: string | null;
      content: unknown;
      history: string[];
    }
  >();
  channels: UserChannelRow[] = [];
  postsMeta: PostMeta[] = [];
  counts = { messages: 0, channels: 0 };
  /** Test seam: makes fail() throw. */
  failError: Error | undefined;
  private seq = 0;

  async create(userId: number, period: { start: Date; end: Date }) {
    this.seq += 1;
    const record = {
      id: `issue-${this.seq}`,
      userId,
      status: 'pending' as const,
      periodStart: period.start,
      periodEnd: period.end,
    };
    this.issues.set(record.id, {
      ...record,
      number: null,
      error: null,
      content: null,
      history: ['pending'],
    });
    return record;
  }
  private get(id: string) {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  }
  async transition(id: string, from: IssueRecord['status'], to: IssueRecord['status']) {
    const issue = this.get(id);
    if (issue.status !== from) throw new StatusTransitionError(id, from, to);
    issue.status = to;
    issue.history.push(to);
  }
  async progress() {}
  async fail(id: string, message: string) {
    if (this.failError !== undefined) throw this.failError;
    const issue = this.get(id);
    if (issue.status === 'ready' || issue.status === 'failed') return;
    issue.status = 'failed';
    issue.error = message;
    issue.history.push('failed');
  }
  async complete(id: string, build: (number: number) => { content: unknown; stats: unknown }) {
    const issue = this.get(id);
    if (issue.status !== 'composing') throw new StatusTransitionError(id, 'composing', 'ready');
    const numbers = [...this.issues.values()]
      .filter((other) => other.userId === issue.userId && other.number !== null)
      .map((other) => other.number ?? 0);
    const number = Math.max(0, ...numbers) + 1;
    issue.content = build(number).content;
    issue.number = number;
    issue.status = 'ready';
    issue.history.push('ready');
    return number;
  }
  async lastReadyPeriodEnd(userId: number) {
    const ends = [...this.issues.values()]
      .filter((issue) => issue.userId === userId && issue.status === 'ready')
      .map((issue) => issue.periodEnd.getTime());
    return ends.length === 0 ? undefined : new Date(Math.max(...ends));
  }
  async getUserChannels() {
    return this.channels;
  }
  async getPostsMeta(ids: readonly number[]) {
    return this.postsMeta.filter((post) => ids.includes(post.id));
  }
  async periodCounts() {
    return this.counts;
  }
}
