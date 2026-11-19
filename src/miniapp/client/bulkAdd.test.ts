import { describe, expect, it, vi } from 'vitest';

import { extractChannelCandidates } from '@/collector/extract';
import type { ResolveChannelsResponse, ResolveStatus } from '@/miniapp/contract';

import type { ApiResult } from './api';
import {
  abortableSleep,
  addButtonState,
  bulkOutcome,
  clearBulkFlash,
  extendSelection,
  foundUsernames,
  hasRetryable,
  initialItems,
  MAX_IDLE_ROUNDS,
  peekBulkFlash,
  progress,
  remainingSlots,
  requeue,
  RETRY_AFTER_CAP_MS,
  runResolveLoop,
  selectedInOrder,
  setBulkFlash,
  toPickerItem,
  type BulkItem,
  type ResolveLoopDeps,
} from './bulkAdd';

const item = (username: string, status: BulkItem['status'] = 'pending'): BulkItem => ({
  username,
  status,
  title: null,
  avatarUrl: null,
});

const ok = (
  results: ResolveChannelsResponse['results'],
  retryAfterMs: number | null = null,
): ApiResult<ResolveChannelsResponse> => ({
  ok: true,
  status: 200,
  data: { results, retryAfterMs },
});

type Answer = (usernames: string[]) => ApiResult<ResolveChannelsResponse>;

function harness(answer: Answer) {
  const controller = new AbortController();
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: ResolveLoopDeps = {
    resolve: async (usernames) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(usernames);
      await Promise.resolve();
      inFlight -= 1;
      return answer(usernames);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onUpdate: vi.fn(),
    signal: controller.signal,
  };
  return { deps, calls, sleeps, controller, maxInFlight: () => maxInFlight };
}

const all =
  (status: ResolveStatus): Answer =>
  (usernames) =>
    ok(usernames.map((username) => ({ username, status, title: `T ${username}` })));

describe('initialItems', () => {
  it('marks bots so they never reach the server', () => {
    const items = initialItems(extractChannelCandidates('@news_feed @helper_bot t.me/rbc_news'));
    expect(items.map((i) => [i.username, i.status])).toEqual([
      ['news_feed', 'pending'],
      ['helper_bot', 'bot'],
      ['rbc_news', 'pending'],
    ]);
    expect(progress(items)).toEqual({ done: 0, total: 2 });
  });
});

describe('runResolveLoop', () => {
  it('sends batches of ≤10, one at a time, in input order, skipping bots', async () => {
    const start = [
      ...Array.from({ length: 23 }, (_, n) => item(`chan_${String(n).padStart(2, '0')}`)),
      item('x_bot', 'bot'),
    ];
    const h = harness(all('found'));
    const result = await runResolveLoop(start, h.deps);
    expect(h.calls.map((c) => c.length)).toEqual([10, 10, 3]);
    expect(h.calls.flat()).toEqual(start.slice(0, 23).map((i) => i.username));
    expect(h.maxInFlight()).toBe(1);
    expect(result.error).toBeNull();
    expect(result.items.at(-1)?.status).toBe('bot');
    expect(result.items[0]).toMatchObject({ status: 'found', title: 'T chan_00' });
    expect(progress(result.items)).toEqual({ done: 23, total: 23 });
    expect(h.sleeps).toEqual([]);
  });

  it('resends pending ones first and waits retryAfterMs, capped', async () => {
    let round = 0;
    const h = harness((usernames) => {
      round += 1;
      if (round === 1) {
        return ok(
          usernames.map((username, i) => ({ username, status: i === 0 ? 'found' : 'pending' })),
          120_000,
        );
      }
      return all('not_found')(usernames);
    });
    const result = await runResolveLoop([item('aaaaa'), item('bbbbb'), item('ccccc')], h.deps);
    expect(h.calls).toEqual([
      ['aaaaa', 'bbbbb', 'ccccc'],
      ['bbbbb', 'ccccc'],
    ]);
    expect(h.sleeps).toEqual([RETRY_AFTER_CAP_MS]);
    expect(result.items.map((i) => i.status)).toEqual(['found', 'not_found', 'not_found']);
  });

  it('gives up on a batch stuck in pending after MAX_IDLE_ROUNDS', async () => {
    const h = harness(all('pending'));
    const result = await runResolveLoop([item('aaaaa')], h.deps);
    expect(h.calls).toHaveLength(MAX_IDLE_ROUNDS);
    expect(result.items[0]?.status).toBe('retry_later');
    expect(hasRetryable(result.items)).toBe(true);
  });

  it('stops on lookup_limit and marks the rest unchecked', async () => {
    let round = 0;
    const h = harness((usernames) => {
      round += 1;
      return round === 1
        ? all('found')(usernames)
        : { ok: false, status: 429, error: { error: 'lookup_limit' } };
    });
    const start = Array.from({ length: 15 }, (_, n) => item(`chan_${String(n).padStart(2, '0')}`));
    const result = await runResolveLoop(start, h.deps);
    expect(h.calls).toHaveLength(2);
    expect(result.error).toEqual({ error: 'lookup_limit' });
    expect(result.items.filter((i) => i.status === 'found')).toHaveLength(10);
    expect(result.items.filter((i) => i.status === 'unchecked')).toHaveLength(5);
    expect(progress(result.items)).toEqual({ done: 10, total: 15 });
  });

  it('stops quietly when aborted mid-request', async () => {
    const h = harness((usernames) => {
      h.controller.abort();
      return all('found')(usernames);
    });
    const result = await runResolveLoop([item('aaaaa')], h.deps);
    expect(result.aborted).toBe(true);
    expect(h.deps.onUpdate).not.toHaveBeenCalled();
  });

  it('requeue retries only retry_later and unchecked', () => {
    const items = [item('a', 'found'), item('b', 'retry_later'), item('c', 'unchecked')];
    expect(requeue(items).map((i) => i.status)).toEqual(['found', 'pending', 'pending']);
  });
});

describe('abortableSleep', () => {
  it('resolves on timeout or abort', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      void abortableSleep(5_000, controller.signal).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);

      let aborted = false;
      void abortableSleep(5_000, controller.signal).then(() => (aborted = true));
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('selection', () => {
  const items = [
    item('a1', 'found'),
    item('b1', 'subscribed'),
    item('c1', 'found'),
    item('d1', 'bot'),
    item('e1', 'found'),
  ];

  it('defaults to the first `remaining` found, input order; null = all', () => {
    expect([...extendSelection(new Set(), foundUsernames(items), 2)]).toEqual(['a1', 'c1']);
    expect([...extendSelection(new Set(), foundUsernames(items), null)]).toEqual([
      'a1',
      'c1',
      'e1',
    ]);
    expect([...extendSelection(new Set(), foundUsernames(items), 0)]).toEqual([]);
  });

  it('keeps unchecked rows unchecked when new ones arrive', () => {
    const next = extendSelection(new Set(['c1']), ['e1'], 5);
    expect(selectedInOrder(items, next)).toEqual(['c1', 'e1']);
  });

  it('commits only selectable rows, in input order', () => {
    expect(selectedInOrder(items, new Set(['e1', 'b1', 'a1', 'd1']))).toEqual(['a1', 'e1']);
  });

  it('remaining slots', () => {
    expect(remainingSlots(48, 50)).toBe(2);
    expect(remainingSlots(55, 50)).toBe(0);
    expect(remainingSlots(500, null)).toBeNull();
  });

  it('rows carry the reason and are not selectable unless found', () => {
    expect(toPickerItem(items[1]!, new Set(['b1']))).toMatchObject({
      title: '@b1',
      status: 'Уже в подписке',
      selectable: false,
      selected: false,
    });
    expect(toPickerItem(items[3]!, new Set())).toMatchObject({ status: 'Бот', selectable: false });
    expect(
      toPickerItem({ ...item('a1', 'found'), title: 'Новости' }, new Set(['a1'])),
    ).toMatchObject({
      title: 'Новости',
      subtitle: '@a1',
      status: null,
      selectable: true,
      selected: true,
    });
  });
});

describe('addButtonState', () => {
  it('shows «Добавить N» only for 1 ≤ N ≤ remaining', () => {
    expect(addButtonState(3, 3, 50)).toEqual({ kind: 'add', count: 3 });
    expect(addButtonState(4, 3, 50)).toEqual({ kind: 'hint', remaining: 3, limit: 50 });
    expect(addButtonState(0, 3, 50)).toEqual({ kind: 'hint', remaining: 3, limit: 50 });
  });

  it('owner: no limit, no hint', () => {
    expect(addButtonState(400, null, null)).toEqual({ kind: 'add', count: 400 });
    expect(addButtonState(0, null, null)).toEqual({ kind: 'none' });
  });
});

describe('bulk result', () => {
  it('counts what did not fit', () => {
    expect(
      bulkOutcome({
        results: [
          { username: 'a', status: 'added' },
          { username: 'b', status: 'exists' },
          { username: 'c', status: 'limit' },
        ],
        added: 1,
        count: 50,
        limit: 50,
      }),
    ).toEqual({ added: 1, overLimit: 1 });
  });

  it('flash survives a peek, expires, clears', () => {
    setBulkFlash('Добавлено 2 канала', 1_000);
    expect(peekBulkFlash(1_500)).toBe('Добавлено 2 канала');
    expect(peekBulkFlash(1_500)).toBe('Добавлено 2 канала');
    expect(peekBulkFlash(20_000)).toBeNull();
    clearBulkFlash();
    expect(peekBulkFlash(1_500)).toBeNull();
  });
});
