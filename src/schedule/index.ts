import { Api } from 'grammy';
import { after } from 'next/server';

import { createIssueNotifier, sendSchedulePaused } from '@/bot/notify';
import { createBotDbStore } from '@/bot/store';
import { getDb } from '@/db';
import { EnvError, getCronEnv, getLlmEnv, type CronEnv } from '@/lib/env';
import { createLlm } from '@/llm/client';
import { llmConfigFromEnv } from '@/llm/config';
import { createAppDbStore } from '@/miniapp/store';
import { createPipelineDeps } from '@/pipeline/deps';

import { createCronApi, type CronApi } from './api';
import { createScheduleDbStore } from './store';

const log = (line: string): void => console.log(line);

let api: CronApi | undefined;
let cronEnv: CronEnv | undefined;

/** Built on the first request, never at import time (keeps `next build` secret-free). */
export function getCronApi(): CronApi {
  if (api === undefined) {
    const db = getDb();
    const env = (): CronEnv => (cronEnv ??= getCronEnv());
    const bot = () => {
      const { TELEGRAM_BOT_TOKEN, APP_URL } = env();
      return { api: new Api(TELEGRAM_BOT_TOKEN), appUrl: APP_URL, store: createBotDbStore(db) };
    };
    api = createCronApi({
      env,
      now: () => new Date(),
      store: createScheduleDbStore(db),
      claimIssue: (input) => createAppDbStore(db).claimIssue(input),
      pipeline: () => createPipelineDeps(db, createLlm(llmConfigFromEnv(getLlmEnv())), { log }),
      notifyReady: (notice) => createIssueNotifier(bot())(notice),
      sendPaused: (userId) => sendSchedulePaused(bot(), userId),
      fetch: (url, init) => fetch(url, init),
      after: (task) => after(task),
      log,
    });
  }
  return api;
}

/** Route-file adapter: a wiring failure (e.g. no DATABASE_URL) answers 500, never throws. */
export function cronHandler(name: keyof CronApi): (req: Request) => Promise<Response> {
  return async (req) => {
    let handler: CronApi[keyof CronApi];
    try {
      handler = getCronApi()[name];
    } catch (error) {
      log(`[cron] misconfigured: ${error instanceof EnvError ? error.message : 'unknown error'}`);
      return Response.json(
        { error: 'misconfigured' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return handler(req);
  };
}
