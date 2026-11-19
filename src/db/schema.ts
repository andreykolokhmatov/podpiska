import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const scheduleFrequencies = [1, 3, 7] as const;

export const users = pgTable(
  'users',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
    username: text('username'),
    firstName: text('first_name'),
    interestsPrompt: text('interests_prompt'),
    // Set when Telegram answers 403 (user blocked the bot); cleared by /start.
    botBlockedAt: timestamp('bot_blocked_at', { withTimezone: true }),
    // Set once the user finishes the Mini App onboarding screen.
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    scheduleEnabled: boolean('schedule_enabled').notNull().default(true),
    scheduleEveryDays: smallint('schedule_every_days').notNull().default(1),
    // Local hour (0..23) in `timezone` when a scheduled issue comes out.
    scheduleHour: smallint('schedule_hour').notNull().default(8),
    // IANA zone reported by the Mini App; null = Europe/Moscow.
    timezone: text('timezone'),
    // The next scheduled build; null = the schedule is not active (yet).
    nextIssueAt: timestamp('next_issue_at', { withTimezone: true }),
    // Set after unread scheduled issues pile up or the bot cannot reach the user.
    schedulePausedAt: timestamp('schedule_paused_at', { withTimezone: true }),
    // Last proof the prod bot may write to the user (/start or write access); null = unknown.
    canNotifyAt: timestamp('can_notify_at', { withTimezone: true }),
    // PDF sends on the MSK day pdf_sends_day; a new day resets the counter in the same UPDATE.
    pdfSendsDay: date('pdf_sends_day', { mode: 'string' }),
    pdfSendsCount: integer('pdf_sends_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'users_schedule_every_days_check',
      sql.raw(`"schedule_every_days" in (${scheduleFrequencies.join(', ')})`),
    ),
    check(
      'users_schedule_hour_check',
      sql`${table.scheduleHour} >= 0 and ${table.scheduleHour} <= 23`,
    ),
    index('users_next_issue_at_idx').on(table.nextIssueAt),
  ],
);

export const channels = pgTable(
  'channels',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    username: text('username').notNull().unique(),
    title: text('title'),
    avatarUrl: text('avatar_url'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    isAvailable: boolean('is_available').notNull().default(true),
  },
  (table) => [
    check('channels_username_lowercase', sql`${table.username} = lower(${table.username})`),
  ],
);

export const userChannels = pgTable(
  'user_channels',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channelId] }),
    index('user_channels_channel_id_idx').on(table.channelId),
  ],
);

// No url column: post links are derived in code from channel username + tg_post_id.
export const posts = pgTable(
  'posts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    tgPostId: integer('tg_post_id').notNull(),
    text: text('text'),
    html: text('html'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    views: integer('views'),
    hasMedia: boolean('has_media').notNull().default(false),
  },
  (table) => [
    unique('posts_channel_id_tg_post_id_unique').on(table.channelId, table.tgPostId),
    index('posts_channel_id_published_at_idx').on(table.channelId, table.publishedAt),
  ],
);

export const channelDigests = pgTable(
  'channel_digests',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    // Calendar day in Europe/Moscow, computed by application code (not by the DB).
    day: date('day', { mode: 'string' }).notNull(),
    summaryJson: jsonb('summary_json').notNull(),
    model: text('model').notNull(),
    // Hash of prompt version + model + post texts; a changed hash invalidates today's digest.
    inputHash: text('input_hash').notNull().default(''),
    // Set on every upsert; a digest computed at/after its day's end is final.
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [unique('channel_digests_channel_id_day_unique').on(table.channelId, table.day)],
);

export const issueStatuses = [
  'pending',
  'collecting',
  'digesting',
  'composing',
  'ready',
  'failed',
] as const;

export type IssueStatus = (typeof issueStatuses)[number];

export const issueTriggers = ['manual', 'scheduled'] as const;

export type IssueTrigger = (typeof issueTriggers)[number];

export const pdfBots = ['prod', 'dev'] as const;

export type PdfBot = (typeof pdfBots)[number];

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Assigned only when the issue becomes ready, so failed runs leave no gaps.
    number: integer('number'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    status: text('status').$type<IssueStatus>().notNull().default('pending'),
    contentJson: jsonb('content_json'),
    error: text('error'),
    statsJson: jsonb('stats_json'),
    // Fan-in counter for the QStash pipeline: compose runs once digests_done = digests_total.
    digestsTotal: integer('digests_total').notNull().default(0),
    digestsDone: integer('digests_done').notNull().default(0),
    // Claim for the "issue ready" message: set before sending, cleared on a transient failure.
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    // Soft delete by the owner: hidden from every read path, but still counted for numbering
    // and the daily quota.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Only manual builds count toward the per-user daily quota; both count globally.
    trigger: text('trigger').$type<IssueTrigger>().notNull().default('manual'),
    // First time the owner opened the issue inside the Mini App (unread auto issues pause).
    openedAt: timestamp('opened_at', { withTimezone: true }),
    // Telegram file_id of the uploaded PDF; valid only for the bot in pdf_file_bot.
    pdfFileId: text('pdf_file_id'),
    pdfFileBot: text('pdf_file_bot').$type<PdfBot>(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('issues_user_id_number_unique').on(table.userId, table.number),
    index('issues_user_id_created_at_idx').on(table.userId, table.createdAt),
    check(
      'issues_status_check',
      sql.raw(`"status" in (${issueStatuses.map((status) => `'${status}'`).join(', ')})`),
    ),
    check(
      'issues_trigger_check',
      sql.raw(`"trigger" in (${issueTriggers.map((trigger) => `'${trigger}'`).join(', ')})`),
    ),
    check(
      'issues_pdf_file_bot_check',
      sql.raw(`"pdf_file_bot" in (${pdfBots.map((bot) => `'${bot}'`).join(', ')})`),
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type UserChannel = typeof userChannels.$inferSelect;
export type NewUserChannel = typeof userChannels.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type ChannelDigest = typeof channelDigests.$inferSelect;
export type NewChannelDigest = typeof channelDigests.$inferInsert;
export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
