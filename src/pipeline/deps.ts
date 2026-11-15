import { collectForChannels, createDbStore, WebPreviewSource } from '@/collector';
import type { Database } from '@/db';
import type { Llm } from '@/llm/client';

import type { PipelineDeps } from './run';
import { createDigestDbStore, createIssueDbStore } from './store';

/** Production wiring of the pipeline: Postgres stores and the t.me web-preview collector. */
export function createPipelineDeps(
  db: Database,
  llm: Llm,
  extra: Partial<Pick<PipelineDeps, 'log' | 'notify' | 'now'>> = {},
): PipelineDeps {
  const source = new WebPreviewSource();
  const channelStore = createDbStore(db);
  return {
    issues: createIssueDbStore(db),
    digests: createDigestDbStore(db),
    collect: (names, since) => collectForChannels(names, since, { source, store: channelStore }),
    llm,
    now: extra.now ?? (() => new Date()),
    ...(extra.log === undefined ? {} : { log: extra.log }),
    ...(extra.notify === undefined ? {} : { notify: extra.notify }),
  };
}
