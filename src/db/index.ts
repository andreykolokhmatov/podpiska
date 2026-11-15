import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { getDatabaseUrl } from '@/lib/env';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let db: Database | undefined;
let pool: Pool | undefined;

/** Lazily creates one pooled client per process; works with Neon and plain Postgres. */
export function getDb(): Database {
  if (db === undefined) {
    pool = new Pool({ connectionString: getDatabaseUrl() });
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Ends the pool (for CLIs/scripts) so the process can exit; getDb() will reconnect. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  db = undefined;
  await current?.end();
}

export { schema };
