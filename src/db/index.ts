import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { getDatabaseUrl } from '@/lib/env';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let db: Database | undefined;

/** Lazily creates one pooled client per process; works with Neon and plain Postgres. */
export function getDb(): Database {
  db ??= drizzle(new Pool({ connectionString: getDatabaseUrl() }), { schema });
  return db;
}

export { schema };
