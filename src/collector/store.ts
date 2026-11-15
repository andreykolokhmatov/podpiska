import { eq, sql } from 'drizzle-orm';

import type { Database } from '@/db';
import { channels, posts } from '@/db/schema';

import type { ChannelInfo, ParsedPost } from './types';

const CHUNK_SIZE = 200;

export interface SaveResult {
  collected: number;
  inserted: number;
}

export interface ChannelStore {
  saveChannelPosts(info: ChannelInfo, posts: ParsedPost[]): Promise<SaveResult>;
  markChannelUnavailable(username: string): Promise<void>;
}

const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/** Upserts the channel and its posts in one transaction; re-running is a no-op for counts. */
export async function saveChannelPosts(
  db: Database,
  info: ChannelInfo,
  parsedPosts: ParsedPost[],
): Promise<SaveResult> {
  const unique = [...new Map(parsedPosts.map((post) => [post.tgPostId, post])).values()];

  return db.transaction(async (tx) => {
    const now = new Date();
    const [channel] = await tx
      .insert(channels)
      .values({
        username: info.username,
        title: info.title,
        avatarUrl: info.avatarUrl,
        isAvailable: true,
        lastFetchedAt: now,
      })
      .onConflictDoUpdate({
        target: channels.username,
        set: {
          title: info.title,
          avatarUrl: info.avatarUrl,
          isAvailable: true,
          lastFetchedAt: now,
        },
      })
      .returning({ id: channels.id });
    if (!channel) {
      throw new Error(`failed to upsert channel ${info.username}`);
    }

    let inserted = 0;
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE);
      const rows = await tx
        .insert(posts)
        .values(
          chunk.map((post) => ({
            channelId: channel.id,
            tgPostId: post.tgPostId,
            text: post.text,
            html: post.html,
            publishedAt: post.publishedAt,
            views: post.views,
            hasMedia: post.hasMedia,
          })),
        )
        .onConflictDoUpdate({
          target: [posts.channelId, posts.tgPostId],
          set: {
            text: excluded('text'),
            html: excluded('html'),
            views: excluded('views'),
            hasMedia: excluded('has_media'),
          },
        })
        // xmax = 0 only for freshly inserted rows, not for rows updated by ON CONFLICT.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      inserted += rows.filter((row) => row.inserted).length;
    }

    return { collected: unique.length, inserted };
  });
}

/** Never creates a row: unknown usernames stay unknown. */
export async function markChannelUnavailable(db: Database, username: string): Promise<void> {
  await db.update(channels).set({ isAvailable: false }).where(eq(channels.username, username));
}

export function createDbStore(db: Database): ChannelStore {
  return {
    saveChannelPosts: (info, parsedPosts) => saveChannelPosts(db, info, parsedPosts),
    markChannelUnavailable: (username) => markChannelUnavailable(db, username),
  };
}
