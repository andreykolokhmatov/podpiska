import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

import { getDatabaseUrl } from './src/lib/env';

// `generate` needs no database; resolve the URL only for commands that connect.
const needsDatabase = !process.argv.includes('generate');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  ...(needsDatabase ? { dbCredentials: { url: getDatabaseUrl({ unpooled: true }) } } : {}),
});
