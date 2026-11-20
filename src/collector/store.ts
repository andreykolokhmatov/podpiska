import { and, eq, ne, sql } from 'drizzle-orm';

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

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UNIQUE_VIOLATION = '23505';

const pgCode = (error: unknown): string | undefined => {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') return current.code;
  }
  return undefined;
};

/**
 * Best-effort: records the channel's bare tg id; null/undefined → no-op, the stored id stays.
 * A channel keeps its tg id across a username change, so the old row is cleared first. Runs in
 * a savepoint: a unique violation from a concurrent writer rolls back only this step and is
 * swallowed (false), so it can never fail the caller's write. Other errors are rethrown.
 */
export async function writeTgId(
  tx: Tx,
  username: string,
  tgId: number | null | undefined,
): Promise<boolean> {
  if (tgId === null || tgId === undefined) return false;
  try {
    await tx.transaction(async (sp) => {
      await sp
        .update(channels)
        .set({ tgId: null })
        .where(and(eq(channels.tgId, tgId), ne(channels.username, username)));
      await sp.update(channels).set({ tgId }).where(eq(channels.username, username));
    });
    return true;
  } catch (error) {
    if (pgCode(error) !== UNIQUE_VIOLATION) throw error;
    console.warn(`tg_id not recorded for @${username}: unique conflict`);
    return false;
  }
}

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
    await writeTgId(tx, info.username, info.tgId);

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
