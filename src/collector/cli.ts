import 'dotenv/config';

import { parseArgs } from 'node:util';

import { closeDb, getDb } from '@/db';

import { collectForChannels } from './collect';
import { createDbStore } from './store';
import { WebPreviewSource } from './web-preview-source';

const USAGE = 'Usage: pnpm collect @channel [@channel ...] [--hours 24]';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { hours: { type: 'string', default: '24' } },
  });
  const hours = Number(values.hours);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error(`--hours must be a positive number\n${USAGE}`);
    return 2;
  }
  if (positionals.length === 0) {
    console.error(USAGE);
    return 2;
  }

  const since = new Date(Date.now() - hours * 3_600_000);
  try {
    const results = await collectForChannels(positionals, since, {
      source: new WebPreviewSource(),
      store: createDbStore(getDb()),
    });

    const width = Math.max(...results.map((result) => result.username.length));
    let collected = 0;
    let inserted = 0;
    let failed = 0;
    for (const result of results) {
      const name = result.username.padEnd(width);
      if (result.ok) {
        collected += result.collected;
        inserted += result.inserted;
        console.log(`${name}  ok     collected ${result.collected} new ${result.inserted}`);
      } else {
        failed += 1;
        console.log(`${name}  error  ${result.code}: ${result.message}`);
      }
    }
    console.log(
      `total: ${results.length} channels, ${failed} failed, collected ${collected} new ${inserted} (since ${since.toISOString()})`,
    );
    return failed === results.length ? 1 : 0;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
