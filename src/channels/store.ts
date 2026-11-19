import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { ChannelInfo } from '@/collector';
import type { Database } from '@/db';
import { channels, userChannels, users } from '@/db/schema';

import type { BulkLinkResult, ChannelsStore } from './add';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Inserts or refreshes a scraped channel as available; returns its id. */
async function upsertAvailable(db: Database | Tx, channel: ChannelInfo): Promise<number> {
  // last_fetched_at is left alone: only collect knows how far the channel was scraped.
  const [row] = await db
    .insert(channels)
    .values({
      username: channel.username,
      title: channel.title,
      avatarUrl: channel.avatarUrl,
      isAvailable: true,
    })
    .onConflictDoUpdate({
      target: channels.username,
      set: {
        title: sql`coalesce(excluded.title, ${channels.title})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${channels.avatarUrl})`,
        isAvailable: true,
      },
    })
    .returning({ id: channels.id });
  if (!row) throw new Error('failed to upsert channel');
  return row.id;
}

/** Serialises concurrent adds of one user so the limit cannot be overshot. */
async function lockUser(tx: Tx, userId: number): Promise<void> {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!user) throw new Error(`user ${userId} not found`);
}

async function countLinks(tx: Tx, userId: number): Promise<number> {
  const [count] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(userChannels)
    .where(eq(userChannels.userId, userId));
  return count?.value ?? 0;
}

export function createChannelsDbStore(db: Database): ChannelsStore {
  return {
    async findAvailableChannel(username) {
      const [row] = await db
        .select({
          username: channels.username,
          title: channels.title,
          avatarUrl: channels.avatarUrl,
        })
        .from(channels)
        .where(and(eq(channels.username, username), eq(channels.isAvailable, true)));
      return row && { ...row, displayUsername: row.username };
    },

    async findAvailableChannels(usernames) {
      if (usernames.length === 0) return [];
      const rows = await db
        .select({
          username: channels.username,
          title: channels.title,
          avatarUrl: channels.avatarUrl,
        })
        .from(channels)
        .where(and(inArray(channels.username, [...usernames]), eq(channels.isAvailable, true)));
      return rows.map((row) => ({ ...row, displayUsername: row.username }));
    },

    async listLinkedUsernames(userId, usernames) {
      if (usernames.length === 0) return [];
      const rows = await db
        .select({ username: channels.username })
        .from(userChannels)
        .innerJoin(channels, eq(channels.id, userChannels.channelId))
        .where(and(eq(userChannels.userId, userId), inArray(channels.username, [...usernames])));
      return rows.map((row) => row.username);
    },

    async upsertChannel(channel) {
      await upsertAvailable(db, channel);
    },

    async linkUserChannel(userId, channel, limit) {
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);

        const [existing] = await tx
          .select({ channelId: userChannels.channelId })
          .from(userChannels)
          .innerJoin(channels, eq(channels.id, userChannels.channelId))
          .where(and(eq(userChannels.userId, userId), eq(channels.username, channel.username)));
        if (existing) return 'exists';

        if (limit !== null && (await countLinks(tx, userId)) >= limit) return 'limit';

        const channelId = await upsertAvailable(tx, channel);
        await tx.insert(userChannels).values({ userId, channelId }).onConflictDoNothing();
        return 'added';
      });
    },

    async linkUserChannels(userId, usernames, limit) {
      const unique = [...new Set(usernames)];
      if (unique.length === 0) return [];
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);

        const known = await tx
          .select({ id: channels.id, username: channels.username })
          .from(channels)
          .where(and(inArray(channels.username, unique), eq(channels.isAvailable, true)));
        const idByName = new Map(known.map((row) => [row.username, row.id]));

        const linked = await tx
          .select({ username: channels.username })
          .from(userChannels)
          .innerJoin(channels, eq(channels.id, userChannels.channelId))
          .where(and(eq(userChannels.userId, userId), inArray(channels.username, unique)));
        const linkedNames = new Set(linked.map((row) => row.username));

        let count = limit === null ? 0 : await countLinks(tx, userId);
        const results: BulkLinkResult[] = [];
        const toInsert: { userId: number; channelId: number }[] = [];
        for (const username of unique) {
          const channelId = idByName.get(username);
          // Linked first: a subscribed channel that went unavailable is still the user's.
          if (linkedNames.has(username)) {
            results.push({ username, status: 'exists' });
          } else if (channelId === undefined) {
            results.push({ username, status: 'not_found' });
          } else if (limit !== null && count >= limit) {
            results.push({ username, status: 'limit' });
          } else {
            count += 1;
            toInsert.push({ userId, channelId });
            results.push({ username, status: 'added' });
          }
        }
        if (toInsert.length > 0) {
          await tx.insert(userChannels).values(toInsert).onConflictDoNothing();
        }
        return results;
      });
    },
  };
}

export interface UserChannelView {
  username: string;
  title: string | null;
  /** Signed t.me CDN URL; expires, refreshed by every collect. */
  avatarUrl: string | null;
  isAvailable: boolean;
}

/** The user's channels, oldest subscription first. */
export async function listUserChannels(db: Database, userId: number): Promise<UserChannelView[]> {
  return db
    .select({
      username: channels.username,
      title: channels.title,
      avatarUrl: channels.avatarUrl,
      isAvailable: channels.isAvailable,
    })
    .from(userChannels)
    .innerJoin(channels, eq(channels.id, userChannels.channelId))
    .where(eq(userChannels.userId, userId))
    .orderBy(asc(userChannels.createdAt), asc(channels.username));
}

/** Unlinks the channel from the user only (the channel, its posts and digests stay). */
export async function removeUserChannel(
  db: Database,
  userId: number,
  username: string,
): Promise<boolean> {
  const rows = await db
    .delete(userChannels)
    .where(
      and(
        eq(userChannels.userId, userId),
        inArray(
          userChannels.channelId,
          db.select({ id: channels.id }).from(channels).where(eq(channels.username, username)),
        ),
      ),
    )
    .returning({ channelId: userChannels.channelId });
  return rows.length > 0;
}
