import { type PoliteFetchOptions, politeFetch } from './http';
import { parseChannelPage } from './parser';
import type { ChannelFetchResult, ChannelInfo, ParsedPost, PostSource } from './types';

export interface WebPreviewSourceOptions extends PoliteFetchOptions {
  baseUrl?: string;
  maxPages?: number;
}

/** Scrapes the public web preview at `t.me/s/<username>`. */
export class WebPreviewSource implements PostSource {
  private readonly baseUrl: string;
  private readonly maxPages: number;
  private readonly fetchOptions: PoliteFetchOptions;

  constructor(options: WebPreviewSourceOptions = {}) {
    const { baseUrl = 'https://t.me', maxPages = 50, ...fetchOptions } = options;
    this.baseUrl = baseUrl;
    this.maxPages = maxPages;
    this.fetchOptions = fetchOptions;
  }

  private pageUrl(username: string, before: number | null): string {
    const url = `${this.baseUrl}/s/${encodeURIComponent(username)}`;
    return before === null ? url : `${url}?before=${before}`;
  }

  async fetchChannelInfo(username: string): Promise<ChannelInfo> {
    const html = await politeFetch(this.pageUrl(username, null), this.fetchOptions);
    return parseChannelPage(html, username).info;
  }

  async fetchChannel(username: string, since: Date): Promise<ChannelFetchResult> {
    const byId = new Map<number, ParsedPost>();
    let info: ChannelInfo | null = null;
    let before: number | null = null;

    for (let page = 0; page < this.maxPages; page += 1) {
      const html = await politeFetch(this.pageUrl(username, before), this.fetchOptions);
      const parsed = parseChannelPage(html, username);
      info ??= parsed.info;

      for (const post of parsed.posts) {
        if (post.publishedAt.getTime() >= since.getTime()) {
          byId.set(post.tgPostId, post);
        }
      }

      if (parsed.messageNodes === 0) {
        break;
      }
      const oldest = parsed.posts.reduce<number | null>(
        (min, post) =>
          min === null ? post.publishedAt.getTime() : Math.min(min, post.publishedAt.getTime()),
        null,
      );
      if (oldest !== null && oldest < since.getTime()) {
        break;
      }
      const cursor = parsed.beforeCursor;
      // Loop guard: the cursor must strictly decrease, otherwise we would refetch forever.
      if (cursor === null || cursor <= 1 || (before !== null && cursor >= before)) {
        break;
      }
      before = cursor;
    }

    if (info === null) {
      throw new Error('unreachable: maxPages must be at least 1');
    }
    const posts = [...byId.values()].sort((a, b) => a.tgPostId - b.tgPostId);
    return { info, posts };
  }
}
