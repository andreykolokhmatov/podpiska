import { Api } from 'grammy';
import { after } from 'next/server';

import { createIssueNotifier } from '@/bot/notify';
import { createBotDbStore } from '@/bot/store';
import { addUserChannel, createChannelsDbStore, createInteractiveSource } from '@/channels';
import { getDb } from '@/db';
import {
  EnvError,
  getBotEnv,
  getLlmEnv,
  getMiniAppEnv,
  type MiniAppEnv,
} from '@/lib/env';
import { createLlm } from '@/llm/client';
import { renderIssuePdf } from '@/pdf';
import { llmConfigFromEnv } from '@/llm/config';
import { createPipelineDeps } from '@/pipeline/deps';
import type { PipelineDeps } from '@/pipeline/run';
import { applyNotifyOutcome } from '@/schedule/service';
import { createScheduleDbStore } from '@/schedule/store';

import { createAppApi, type AppApi, type AppApiDeps, type IdHandler } from './api';
import { sendIssuePdf } from './pdf-send';
import { buildShareResult } from './share';
import { createAppDbStore } from './store';

const log = (line: string): void => console.log(line);

function createNotify(): NonNullable<PipelineDeps['notify']> {
  return async (notice) => {
    // Read lazily: a missing bot variable must cost the notice, never the ready issue.
    const env = getBotEnv();
    const db = getDb();
    const notifier = createIssueNotifier({
      api: new Api(env.TELEGRAM_BOT_TOKEN),
      appUrl: env.APP_URL,
      store: createBotDbStore(db),
    });
    const outcome = await notifier(notice);
    log(`[app] notify ${notice.issueId}: ${outcome}`);
    await applyNotifyOutcome(createScheduleDbStore(db), notice.userId, outcome, new Date());
  };
}

let api: AppApi | undefined;
let miniAppEnv: MiniAppEnv | undefined;

const miniAppEnvOnce = (): MiniAppEnv => (miniAppEnv ??= getMiniAppEnv());

interface BotClient {
  api: Api;
  username: Promise<string>;
}

// Keyed by which bot signed the initData; the token itself is never a key, logged or returned.
const botClients = new Map<'prod' | 'dev', BotClient>();

function botClient(bot: 'prod' | 'dev'): BotClient {
  let client = botClients.get(bot);
  if (client === undefined) {
    const env = miniAppEnvOnce();
    const token = bot === 'prod' ? env.TELEGRAM_BOT_TOKEN : env.TELEGRAM_DEV_BOT_TOKEN;
    // Unreachable in practice: dev-signed initData only verifies when the dev token is set.
    if (token === undefined) throw new EnvError('TELEGRAM_DEV_BOT_TOKEN: is required');
    const botApi = new Api(token);
    const username = botApi.getMe().then((me) => me.username);
    // A failed getMe must not stick for the life of the instance.
    username.catch(() => botClients.delete(bot));
    client = { api: botApi, username };
    botClients.set(bot, client);
  }
  return client;
}

const share: AppApiDeps['share'] = async (input) => {
  const client = botClient(input.bot);
  const result = buildShareResult({
    issueId: input.issueId,
    number: input.number,
    headline: input.headline,
    botUsername: await client.username,
  });
  // Saved on every tap: a prepared message expires, so its id is never cached.
  const prepared = await client.api.savePreparedInlineMessage(input.telegramUserId, result, {
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
    allow_bot_chats: false,
  });
  return prepared.id;
};

const sendPdf: AppApiDeps['sendPdf'] = (input) => {
  const client = botClient(input.bot);
  return sendIssuePdf(
    {
      render: renderIssuePdf,
      sendDocument: (chatId, document, options) =>
        client.api.sendDocument(chatId, document, options),
      log,
    },
    input,
  );
};

/** Built on the first request, never at import time (keeps `next build` secret-free). */
export function getAppApi(): AppApi {
  if (api === undefined) {
    const db = getDb();
    const channelDeps = { store: createChannelsDbStore(db), source: createInteractiveSource() };
    api = createAppApi({
      store: createAppDbStore(db),
      schedules: createScheduleDbStore(db),
      env: miniAppEnvOnce,
      now: () => new Date(),
      addChannel: (userId, username, limit) => addUserChannel(channelDeps, userId, username, limit),
      pipeline: () =>
        createPipelineDeps(db, createLlm(llmConfigFromEnv(getLlmEnv())), {
          log,
          notify: createNotify(),
        }),
      schedule: (task) => after(task),
      share,
      sendPdf,
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

type WithId = 'getIssue' | 'deleteIssue' | 'shareIssue' | 'sendPdf';
type Simple = Exclude<keyof AppApi, WithId>;

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

type RouteContext = { params: Promise<{ id: string }> };

/** Route-file adapter for /api/app/issues/[id]/*; a wiring failure answers 500, never throws. */
export function appIdHandler(name: WithId): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, ctx) => {
    const { id } = await ctx.params;
    let handler: IdHandler;
    try {
      handler = getAppApi()[name];
    } catch (error) {
      return misconfigured(error);
    }
    return handler(req, id);
  };
}
