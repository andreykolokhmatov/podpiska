import { drizzle } from 'drizzle-orm/node-postgres';

import type { Database } from '@/db';
import * as schema from '@/db/schema';

export interface RecordedQuery {
  text: string;
  params: unknown[];
}

/**
 * A Drizzle database over a fake pg client: records the SQL it would send and answers each
 * query with `respond(text)` rows (array row mode, columns in select order). No Postgres needed.
 */
export function recordingDb(respond: (text: string) => unknown[][] = () => []): {
  db: Database;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (config: string | { text: string }, params: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      queries.push({ text, params });
      const rows = respond(text);
      return { rows, rowCount: rows.length, fields: [], command: '' };
    },
  };
  return { db: drizzle({ client: client as never, schema }), queries };
}
