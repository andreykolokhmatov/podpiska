import { eq } from 'drizzle-orm';
import { cache } from 'react';
import { z } from 'zod';

import type { IssueStatus } from '@/db/schema';
import { issueSchema, type Issue as IssueDoc } from '@/pipeline/schema';

export interface IssueRow {
  id: string;
  status: IssueStatus;
  contentJson: unknown;
}

export type IssueView =
  | { kind: 'not-found' }
  | { kind: 'building'; status: IssueStatus }
  | { kind: 'failed' }
  | { kind: 'invalid' }
  | { kind: 'ready'; issue: IssueDoc };

export type FetchIssueRow = (id: string) => Promise<IssueRow | undefined>;

const uuidSchema = z.uuid();

/** Pure status → view mapping. Invalid content logs the id and zod paths only, never the content. */
export function resolveIssueView(row: IssueRow | undefined): IssueView {
  if (row === undefined) return { kind: 'not-found' };
  if (row.status === 'failed') return { kind: 'failed' };
  if (row.status !== 'ready') return { kind: 'building', status: row.status };

  const parsed = issueSchema.safeParse(row.contentJson);
  if (!parsed.success) {
    console.error('[issue] invalid content_json', {
      id: row.id,
      paths: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    });
    return { kind: 'invalid' };
  }
  return { kind: 'ready', issue: parsed.data };
}

/** The uuid guard runs before the fetcher, so a malformed id never reaches Postgres. */
export function createIssueLoader(fetchRow: FetchIssueRow): (id: string) => Promise<IssueView> {
  return async (id) => {
    if (!uuidSchema.safeParse(id).success) return { kind: 'not-found' };
    return resolveIssueView(await fetchRow(id));
  };
}

const fetchIssueRow: FetchIssueRow = async (id) => {
  const { getDb, schema } = await import('@/db');
  const [row] = await getDb()
    .select({
      id: schema.issues.id,
      status: schema.issues.status,
      contentJson: schema.issues.contentJson,
    })
    .from(schema.issues)
    .where(eq(schema.issues.id, id))
    .limit(1);
  return row;
};

/** Shared by generateMetadata and the page within one request. */
export const loadIssueView = cache(createIssueLoader(fetchIssueRow));
