import 'dotenv/config';

import { parseArgs } from 'node:util';

import { collectForChannels, createDbStore, normalizeChannel, WebPreviewSource } from '@/collector';
import { closeDb, getDb } from '@/db';
import { createLlm } from '@/llm/client';
import { llmConfigFromEnv } from '@/llm/config';
import { getLlmEnv } from '@/lib/env';

import { IssueFailedError, runIssuePipeline, type IssueStats } from './run';
import {
  createDigestDbStore,
  createIssueDbStore,
  replaceUserChannels,
  upsertDevUser,
} from './store';

const USAGE =
  'Usage: pnpm issue --user <telegram_id> [--days 1] [--channels @a @b ...] [--interests "..."] [--refresh-digests]';

const tokens = (stats: IssueStats): string => {
  const { digest, compose } = stats.tokens;
  return `tokens: digest ${digest.calls} calls in ${digest.inputTokens} out ${digest.outputTokens}; compose ${compose.calls} calls in ${compose.inputTokens} out ${compose.outputTokens} (reasoning ${compose.reasoningTokens})`;
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      user: { type: 'string' },
      days: { type: 'string', default: '1' },
      channels: { type: 'string' },
      interests: { type: 'string' },
      'refresh-digests': { type: 'boolean', default: false },
    },
  });
  const telegramId = Number(values.user);
  const days = Number(values.days);
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    console.error(`--user must be a positive integer\n${USAGE}`);
    return 2;
  }
  if (!Number.isInteger(days) || days < 1 || days > 7) {
    console.error(`--days must be 1..7\n${USAGE}`);
    return 2;
  }
  if (values.channels === undefined && positionals.length > 0) {
    console.error(USAGE);
    return 2;
  }
  // `--channels @a @b` parses as one option value plus positionals.
  const channelInputs =
    values.channels === undefined ? undefined : [values.channels, ...positionals];
  const usernames = channelInputs && [...new Set(channelInputs.map(normalizeChannel))];

  const llm = createLlm(llmConfigFromEnv(getLlmEnv()));
  const db = getDb();
  try {
    const user = await upsertDevUser(db, telegramId, values.interests);
    if (usernames !== undefined) {
      await replaceUserChannels(db, user.id, usernames);
    }
    const source = new WebPreviewSource();
    const channelStore = createDbStore(db);
    const result = await runIssuePipeline(
      {
        issues: createIssueDbStore(db),
        digests: createDigestDbStore(db),
        collect: (names, since) =>
          collectForChannels(names, since, { source, store: channelStore }),
        llm,
        now: () => new Date(),
        log: (line) => console.log(line),
      },
      {
        userId: user.id,
        days,
        interests: user.interests,
        refreshDigests: values['refresh-digests'],
      },
    );

    const { stats, content } = result;
    for (const error of stats.collect.errors) {
      console.log(`collect error ${error.channel}: ${error.code} ${error.message}`);
    }
    for (const error of stats.digestErrors) {
      console.log(`digest error ${error.channel} ${error.day}: ${error.message}`);
    }
    console.log(`issue ${result.issueId} №${result.number} ready`);
    console.log(
      `${stats.messages} messages · ${stats.channels} channels · ${content.masthead.dateline}`,
    );
    console.log(
      `digests: ${stats.digests.cached} cached, ${stats.digests.generated} generated, ${stats.digests.empty} empty, ${stats.digests.failed} failed`,
    );
    console.log(
      `dropped: ${stats.dropped.refs} refs, ${stats.dropped.notes} notes, ${stats.dropped.duplicates} duplicates`,
    );
    console.log(tokens(stats));
    console.log(`lead: ${content.lead.headline}`);
    const rubrics = [
      content.frontSection?.rubric,
      content.sideSection?.rubric,
      ...(content.sections ?? []).map((section) => `${section.rubric} (${section.layout})`),
    ].filter((rubric): rubric is string => rubric !== undefined);
    console.log(`rubrics: ${rubrics.join(' · ') || '(none)'}`);
    return 0;
  } catch (error) {
    if (error instanceof IssueFailedError) {
      console.error(`issue ${error.issueId} failed: ${error.message}`);
      console.error(tokens(error.stats));
    } else {
      console.error(error instanceof Error ? error.message : 'unknown error');
    }
    return 1;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  },
);
