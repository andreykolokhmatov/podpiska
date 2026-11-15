import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@/db';
import { channels, userChannels, users } from '@/db/schema';

import type { ChannelsStore } from './add';

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

    async linkUserChannel(userId, channel, limit) {
      return db.transaction(async (tx) => {
        // Serialises concurrent adds of one user so the limit cannot be overshot.
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!user) throw new Error(`user ${userId} not found`);

        const [existing] = await tx
          .select({ channelId: userChannels.channelId })
          .from(userChannels)
          .innerJoin(channels, eq(channels.id, userChannels.channelId))
          .where(and(eq(userChannels.userId, userId), eq(channels.username, channel.username)));
        if (existing) return 'exists';

        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(userChannels)
          .where(eq(userChannels.userId, userId));
        if ((count?.value ?? 0) >= limit) return 'limit';

        // last_fetched_at is left alone: only collect knows how far the channel was scraped.
        const [row] = await tx
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

        await tx.insert(userChannels).values({ userId, channelId: row.id }).onConflictDoNothing();
        return 'added';
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
