import { Api } from 'grammy';
import { after } from 'next/server';

import { createIssueNotifier } from '@/bot/notify';
import { createBotDbStore } from '@/bot/store';
import { addUserChannel, createChannelsDbStore, createInteractiveSource } from '@/channels';
import { getDb } from '@/db';
import { EnvError, getBotEnv, getLlmEnv, getMiniAppEnv, type MiniAppEnv } from '@/lib/env';
import { createLlm } from '@/llm/client';
import { llmConfigFromEnv } from '@/llm/config';
import { createPipelineDeps } from '@/pipeline/deps';
import type { PipelineDeps } from '@/pipeline/run';

import { createAppApi, type AppApi } from './api';
import { createAppDbStore } from './store';

const log = (line: string): void => console.log(line);

function createNotify(): NonNullable<PipelineDeps['notify']> {
  return async (notice) => {
    // Read lazily: a missing bot variable must cost the notice, never the ready issue.
    const env = getBotEnv();
    const notifier = createIssueNotifier({
      api: new Api(env.TELEGRAM_BOT_TOKEN),
      appUrl: env.APP_URL,
      store: createBotDbStore(getDb()),
    });
    log(`[app] notify ${notice.issueId}: ${await notifier(notice)}`);
  };
}

let api: AppApi | undefined;
let miniAppEnv: MiniAppEnv | undefined;

/** Built on the first request, never at import time (keeps `next build` secret-free). */
export function getAppApi(): AppApi {
  if (api === undefined) {
    const db = getDb();
    const channelDeps = { store: createChannelsDbStore(db), source: createInteractiveSource() };
    api = createAppApi({
      store: createAppDbStore(db),
      env: () => (miniAppEnv ??= getMiniAppEnv()),
      now: () => new Date(),
      addChannel: (userId, username, limit) => addUserChannel(channelDeps, userId, username, limit),
      pipeline: () =>
        createPipelineDeps(db, createLlm(llmConfigFromEnv(getLlmEnv())), {
          log,
          notify: createNotify(),
        }),
      schedule: (task) => after(task),
      log,
    });
  }
  return api;
}

const misconfigured = (error: unknown): Response => {
  // EnvError messages list keys and reasons only, never values.
  log(`[app] misconfigured: ${error instanceof EnvError ? error.message : 'unknown error'}`);
  return Response.json(
    { error: 'misconfigured' },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
};

type Simple = Exclude<keyof AppApi, 'getIssue'>;

/** Route-file adapter: a wiring failure (e.g. no DATABASE_URL) answers 500, never throws. */
export function appHandler(name: Simple): (req: Request) => Promise<Response> {
  return async (req) => {
    let handler: AppApi[Simple];
    try {
      handler = getAppApi()[name];
    } catch (error) {
      return misconfigured(error);
    }
    return handler(req);
  };
}

export async function handleGetIssue(req: Request, id: string): Promise<Response> {
  let handler: AppApi['getIssue'];
  try {
    handler = getAppApi().getIssue;
  } catch (error) {
    return misconfigured(error);
  }
  return handler(req, id);
}
