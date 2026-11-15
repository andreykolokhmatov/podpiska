import { describe, expect, it } from 'vitest';

import type { IssueState } from '@/miniapp/contract';

import {
  buildButtonView,
  buildReducer,
  deriveChecklist,
  failureText,
  initialBuildState,
  nextPollDelay,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  progressLabel,
  quotaText,
  SLOW_AFTER_MS,
  type BuildState,
} from './build';
import { issueErrorText } from './texts';

const ID = '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f';

const issue = (over: Partial<IssueState> = {}): IssueState => ({
  id: ID,
  status: 'collecting',
  progress: { step: 'collecting', done: null, total: null },
  error: null,
  number: null,
  ...over,
});

const polling = (since = 0, polls = 0): BuildState => ({
  kind: 'polling',
  issueId: ID,
  since,
  issue: null,
  polls,
});

describe('buildReducer', () => {
  it('start → starting; ignored while busy', () => {
    const s = buildReducer(initialBuildState, { type: 'start' });
    expect(s).toEqual({ kind: 'starting' });
    expect(buildReducer(s, { type: 'start' })).toBe(s);
    const p = polling();
    expect(buildReducer(p, { type: 'start' })).toBe(p);
  });

  it('can restart after a failure', () => {
    const failed: BuildState = { kind: 'failed', failure: { source: 'issue', code: 'no_posts' } };
    expect(buildReducer(failed, { type: 'start' })).toEqual({ kind: 'starting' });
  });

  it('started → polling the new issue', () => {
    const s = buildReducer({ kind: 'starting' }, { type: 'started', issue: issue(), now: 10 });
    expect(s).toMatchObject({ kind: 'polling', issueId: ID, since: 10, polls: 0 });
  });

  it('409 busy → polls the existing issue', () => {
    const s = buildReducer({ kind: 'starting' }, { type: 'busy', issueId: ID, now: 5 });
    expect(s).toMatchObject({ kind: 'polling', issueId: ID, since: 5, issue: null });
  });

  it('429 / 422 → failed with the api code', () => {
    expect(buildReducer({ kind: 'starting' }, { type: 'rejected', code: 'limit' })).toEqual({
      kind: 'failed',
      failure: { source: 'api', code: 'limit' },
    });
  });

  it('resume from me.inFlight → polling; ignored when already busy', () => {
    const s = buildReducer(initialBuildState, {
      type: 'resume',
      issue: issue({ status: 'digesting' }),
      now: 1,
    });
    expect(s).toMatchObject({ kind: 'polling', issueId: ID });
    const busy = polling();
    expect(buildReducer(busy, { type: 'resume', issue: issue(), now: 2 })).toBe(busy);
  });

  it('polled ready → ready; failed → failed with issue error', () => {
    expect(
      buildReducer(polling(), {
        type: 'polled',
        issue: issue({ status: 'ready', number: 4 }),
        now: 1,
      }),
    ).toEqual({ kind: 'ready', issueId: ID });
    expect(
      buildReducer(polling(), {
        type: 'polled',
        issue: issue({ status: 'failed', error: 'no_news' }),
        now: 1,
      }),
    ).toEqual({ kind: 'failed', failure: { source: 'issue', code: 'no_news' } });
  });

  it('failed without an error code reads as internal', () => {
    expect(
      buildReducer(polling(), { type: 'polled', issue: issue({ status: 'failed' }), now: 1 }),
    ).toEqual({ kind: 'failed', failure: { source: 'issue', code: 'internal' } });
  });

  it('every poll answer bumps polls so the loop re-arms', () => {
    const a = buildReducer(polling(0, 3), { type: 'polled', issue: issue(), now: 1 });
    expect(a).toMatchObject({ kind: 'polling', polls: 4 });
    const b = buildReducer(polling(0, 3), { type: 'pollFailed', code: 'network', now: 1 });
    expect(b).toMatchObject({ kind: 'polling', polls: 4 });
  });

  it('ignores answers for another issue', () => {
    const p = polling();
    expect(buildReducer(p, { type: 'polled', issue: issue({ id: 'x' }), now: 1 })).toBe(p);
  });

  it.each(['unauthorized', 'expired', 'not_found'] as const)('poll %s stops', (code) => {
    expect(buildReducer(polling(), { type: 'pollFailed', code, now: 1 })).toEqual({
      kind: 'failed',
      failure: { source: 'api', code },
    });
  });

  it('after 6 minutes → slow (from answers and from transient errors)', () => {
    expect(
      buildReducer(polling(0), { type: 'polled', issue: issue(), now: SLOW_AFTER_MS }),
    ).toEqual({
      kind: 'slow',
      issueId: ID,
    });
    expect(
      buildReducer(polling(0), { type: 'pollFailed', code: 'internal', now: SLOW_AFTER_MS }),
    ).toEqual({ kind: 'slow', issueId: ID });
    expect(
      buildReducer(polling(0), { type: 'polled', issue: issue(), now: SLOW_AFTER_MS - 1 }).kind,
    ).toBe('polling');
  });

  it('stale events in idle are ignored', () => {
    expect(buildReducer(initialBuildState, { type: 'polled', issue: issue(), now: 1 })).toBe(
      initialBuildState,
    );
    expect(buildReducer(initialBuildState, { type: 'started', issue: issue(), now: 1 })).toBe(
      initialBuildState,
    );
  });
});

describe('nextPollDelay', () => {
  it('2s for the first minute, then 5s; null when not polling', () => {
    expect(nextPollDelay(polling(0), 59_999)).toBe(POLL_FAST_MS);
    expect(nextPollDelay(polling(0), 60_000)).toBe(POLL_SLOW_MS);
    expect(nextPollDelay(initialBuildState, 0)).toBeNull();
    expect(nextPollDelay({ kind: 'ready', issueId: ID }, 0)).toBeNull();
  });
});

describe('progressLabel', () => {
  it('maps steps to MainButton text', () => {
    expect(progressLabel(null)).toBe('Собираем посты…');
    expect(progressLabel(issue({ status: 'pending', progress: null }))).toBe('Собираем посты…');
    expect(progressLabel(issue())).toBe('Собираем посты…');
    expect(
      progressLabel(
        issue({ status: 'digesting', progress: { step: 'digesting', done: 2, total: 5 } }),
      ),
    ).toBe('Читаем каналы 2/5');
    expect(
      progressLabel(
        issue({ status: 'digesting', progress: { step: 'digesting', done: null, total: null } }),
      ),
    ).toBe('Читаем каналы…');
    expect(
      progressLabel(
        issue({ status: 'digesting', progress: { step: 'digesting', done: 9, total: 5 } }),
      ),
    ).toBe('Читаем каналы 5/5');
    expect(
      progressLabel(
        issue({ status: 'composing', progress: { step: 'composing', done: null, total: null } }),
      ),
    ).toBe('Верстаем номер…');
  });
});

describe('buildButtonView', () => {
  const quota = { limit: 3, used: 1, remaining: 2 };

  it('idle: enabled only with channels and quota left', () => {
    expect(buildButtonView(initialBuildState, { channelCount: 2, quota })).toMatchObject({
      text: 'СОБРАТЬ ВЫПУСК',
      enabled: true,
    });
    expect(buildButtonView(initialBuildState, { channelCount: 0, quota }).enabled).toBe(false);
    expect(
      buildButtonView(initialBuildState, {
        channelCount: 2,
        quota: { limit: 3, used: 3, remaining: 0 },
      }).enabled,
    ).toBe(false);
    expect(buildButtonView(initialBuildState, { channelCount: 1, quota: null }).enabled).toBe(true);
  });

  it('starting shows the loader; polling shows progress with shine', () => {
    expect(buildButtonView({ kind: 'starting' }, { channelCount: 1, quota })).toMatchObject({
      enabled: false,
      loader: true,
    });
    expect(buildButtonView(polling(), { channelCount: 1, quota })).toMatchObject({
      text: 'Собираем посты…',
      loader: false,
      shine: true,
    });
  });
});

describe('quotaText', () => {
  it('hidden for the owner, counts down otherwise', () => {
    expect(quotaText(null)).toBeNull();
    expect(quotaText({ limit: 3, used: 0, remaining: 3 })).toBe('Осталось 3 из 3 сегодня');
    expect(quotaText({ limit: 3, used: 2, remaining: 1 })).toBe('Осталось 1 из 3 сегодня');
    expect(quotaText({ limit: 3, used: 4, remaining: -1 })).toBe('Осталось 0 из 3 сегодня');
  });
});

describe('deriveChecklist', () => {
  it('first undone step is current', () => {
    expect(deriveChecklist({ channelCount: 0, hasInterests: false, hasIssue: false })).toEqual([
      { id: 'channels', index: 1, state: 'current' },
      { id: 'interests', index: 2, state: 'todo' },
      { id: 'issue', index: 3, state: 'todo' },
    ]);
    expect(
      deriveChecklist({ channelCount: 2, hasInterests: false, hasIssue: true })?.map(
        (s) => s.state,
      ),
    ).toEqual(['done', 'current', 'done']);
  });

  it('hidden once all three are done', () => {
    expect(deriveChecklist({ channelCount: 1, hasInterests: true, hasIssue: true })).toBeNull();
  });
});

describe('failureText', () => {
  it('uses issue and api copy', () => {
    expect(failureText({ source: 'issue', code: 'no_posts' })).toBe(issueErrorText.no_posts);
    expect(failureText({ source: 'api', code: 'limit' })).toMatch(/3 в день/);
  });
});
