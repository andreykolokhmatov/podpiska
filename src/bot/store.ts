import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db';
import { issues, users } from '@/db/schema';

export interface TelegramUser {
  id: number;
  username?: string | undefined;
  first_name: string;
}

export interface BotStore {
  /**
   * Creates or refreshes the user from a private message: clears bot_blocked_at and records that
   * the bot may write to them (can_notify_at).
   */
  upsertUser(from: TelegramUser): Promise<{ id: number }>;
  /** Chat id for notifications; undefined if the user is unknown or blocked the bot. */
  telegramIdOf(userId: number): Promise<number | undefined>;
  /** Atomically claims the "issue ready" message; false if already claimed. */
  claimNotify(issueId: string): Promise<boolean>;
  releaseNotify(issueId: string): Promise<void>;
  markBlocked(userId: number): Promise<void>;
}

export function createBotDbStore(db: Database): BotStore {
  return {
    async upsertUser(from) {
      const profile = {
        username: from.username ?? null,
        firstName: from.first_name,
        canNotifyAt: new Date(),
      };
      const [row] = await db
        .insert(users)
        .values({ telegramId: from.id, ...profile })
        .onConflictDoUpdate({ target: users.telegramId, set: { ...profile, botBlockedAt: null } })
        .returning({ id: users.id });
      if (!row) throw new Error('failed to upsert user');
      return row;
    },
    async telegramIdOf(userId) {
      const [row] = await db
        .select({ telegramId: users.telegramId })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.botBlockedAt)));
      return row?.telegramId;
    },
    async claimNotify(issueId) {
      const rows = await db
        .update(issues)
        .set({ notifiedAt: new Date() })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.status, 'ready'),
            isNull(issues.notifiedAt),
            isNull(issues.deletedAt),
          ),
        )
        .returning({ id: issues.id });
      return rows.length > 0;
    },
    async releaseNotify(issueId) {
      await db.update(issues).set({ notifiedAt: null }).where(eq(issues.id, issueId));
    },
    async markBlocked(userId) {
      await db.update(users).set({ botBlockedAt: new Date() }).where(eq(users.id, userId));
    },
  };
}
