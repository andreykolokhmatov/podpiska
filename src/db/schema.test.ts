import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  channelDigests,
  channels,
  issues,
  issueStatuses,
  posts,
  userChannels,
  users,
} from './schema';

const uniqueColumnSets = (table: PgTable): string[][] =>
  getTableConfig(table).uniqueConstraints.map((constraint) =>
    constraint.columns.map((column) => column.name),
  );

const checkNames = (table: PgTable): string[] =>
  getTableConfig(table).checks.map((constraint) => constraint.name);

describe('schema', () => {
  it('user_channels has a composite primary key', () => {
    const [pk, ...rest] = getTableConfig(userChannels).primaryKeys;
    expect(rest).toHaveLength(0);
    expect(pk?.columns.map((column) => column.name)).toEqual(['user_id', 'channel_id']);
  });

  it('posts are unique per (channel_id, tg_post_id)', () => {
    expect(uniqueColumnSets(posts)).toContainEqual(['channel_id', 'tg_post_id']);
  });

  it('channel digests are unique per (channel_id, day) with a date column', () => {
    expect(uniqueColumnSets(channelDigests)).toContainEqual(['channel_id', 'day']);
    const day = getTableConfig(channelDigests).columns.find((column) => column.name === 'day');
    expect(day?.getSQLType()).toBe('date');
  });

  it('users.telegram_id is a unique bigint', () => {
    const column = getTableConfig(users).columns.find((c) => c.name === 'telegram_id');
    expect(column?.isUnique).toBe(true);
    expect(column?.getSQLType()).toBe('bigint');
  });

  it('channels enforce lowercase usernames', () => {
    expect(checkNames(channels)).toContain('channels_username_lowercase');
  });

  it('issues have a status check and unique (user_id, number)', () => {
    expect(checkNames(issues)).toContain('issues_status_check');
    expect(uniqueColumnSets(issues)).toContainEqual(['user_id', 'number']);
    expect(issueStatuses).toHaveLength(6);
  });

  it('issues.deleted_at is a nullable timestamptz (soft delete)', () => {
    const column = getTableConfig(issues).columns.find((c) => c.name === 'deleted_at');
    expect(column?.getSQLType()).toBe('timestamp with time zone');
    expect(column?.notNull).toBe(false);
  });

  it('all foreign keys cascade on delete', () => {
    const tables = [userChannels, posts, channelDigests, issues];
    const actions = tables.flatMap((table) =>
      getTableConfig(table).foreignKeys.map((fk) => fk.onDelete),
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action === 'cascade')).toBe(true);
  });
});
