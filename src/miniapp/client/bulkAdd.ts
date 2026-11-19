import type { ExtractResult } from '@/collector/extract';
import {
  RESOLVE_BATCH_MAX,
  type BulkAddResponse,
  type ResolveChannelsResponse,
  type ResolveStatus,
} from '@/miniapp/contract';

import type { ApiResult, ClientError } from './api';
import type { PickerItem } from './components/CandidateList';
import { t } from './texts';

/** `unchecked`: the loop stopped before this one (lookup quota, network); offer a retry. */
export type BulkItemStatus = ResolveStatus | 'unchecked';

export interface BulkItem {
  username: string;
  status: BulkItemStatus;
  title: string | null;
  avatarUrl: string | null;
}

/** Never re-checked after this many rounds without progress (server kept answering `pending`). */
export const MAX_IDLE_ROUNDS = 3;
/** retryAfterMs from t.me can be long; the screen is open, so wait at most this much per round. */
export const RETRY_AFTER_CAP_MS = 30_000;
const IDLE_ROUND_DELAY_MS = 1_000;

/** Bots never reach the server: Telegram reserves the suffix for them. */
export function initialItems(extracted: ExtractResult): BulkItem[] {
  return extracted.candidates.map(({ username, bot }) => ({
    username,
    status: bot ? 'bot' : 'pending',
    title: null,
    avatarUrl: null,
  }));
}

const checkable = (item: BulkItem) => item.status !== 'bot';

export function progress(items: readonly BulkItem[]): { done: number; total: number } {
  const total = items.filter(checkable).length;
  const done = items.filter(
    (i) => checkable(i) && i.status !== 'pending' && i.status !== 'unchecked',
  ).length;
  return { done, total };
}

export const isSelectable = (item: BulkItem): boolean => item.status === 'found';

/** retry_later and unchecked go back to the queue; everything else is final. */
export function requeue(items: readonly BulkItem[]): BulkItem[] {
  return items.map((i) =>
    i.status === 'retry_later' || i.status === 'unchecked' ? { ...i, status: 'pending' } : i,
  );
}

export const hasRetryable = (items: readonly BulkItem[]): boolean =>
  items.some((i) => i.status === 'retry_later' || i.status === 'unchecked');

export interface ResolveLoopDeps {
  resolve: (
    usernames: string[],
    signal: AbortSignal,
  ) => Promise<ApiResult<ResolveChannelsResponse>>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onUpdate: (items: BulkItem[]) => void;
  signal: AbortSignal;
}

export interface ResolveLoopResult {
  items: BulkItem[];
  /** Why the loop stopped early; the rest is marked `unchecked`. */
  error: ClientError | null;
  aborted: boolean;
}

/**
 * Checks every `pending` item in batches of RESOLVE_BATCH_MAX, strictly one request at a time
 * (the server shares one t.me limiter). Items the server left `pending` go out again first.
 */
export async function runResolveLoop(
  start: readonly BulkItem[],
  deps: ResolveLoopDeps,
): Promise<ResolveLoopResult> {
  let items = [...start];
  let idleRounds = 0;
  const stop = (error: ClientError | null): ResolveLoopResult => {
    items = items.map((i) => (i.status === 'pending' ? { ...i, status: 'unchecked' } : i));
    deps.onUpdate(items);
    return { items, error, aborted: false };
  };
  const aborted = (): ResolveLoopResult => ({ items, error: null, aborted: true });

  for (;;) {
    if (deps.signal.aborted) return aborted();
    const batch = items.filter((i) => i.status === 'pending').slice(0, RESOLVE_BATCH_MAX);
    if (batch.length === 0) return { items, error: null, aborted: false };

    const res = await deps.resolve(
      batch.map((i) => i.username),
      deps.signal,
    );
    if (deps.signal.aborted) return aborted();
    if (!res.ok) return stop(res.error);

    const byUsername = new Map<string, ResolveChannelsResponse['results'][number]>();
    batch.forEach((item, index) => {
      const result = res.data.results[index];
      if (result) byUsername.set(item.username, result);
    });
    let progressed = false;
    items = items.map((item) => {
      const result = byUsername.get(item.username);
      if (!result || item.status !== 'pending') return item;
      if (result.status !== 'pending') progressed = true;
      return {
        ...item,
        status: result.status,
        title: result.title ?? item.title,
        avatarUrl: result.avatarUrl ?? item.avatarUrl,
      };
    });
    deps.onUpdate(items);

    idleRounds = progressed ? 0 : idleRounds + 1;
    if (idleRounds >= MAX_IDLE_ROUNDS) {
      const stuck = new Set(batch.map((i) => i.username));
      items = items.map((i) =>
        stuck.has(i.username) && i.status === 'pending' ? { ...i, status: 'retry_later' } : i,
      );
      deps.onUpdate(items);
      idleRounds = 0;
      continue;
    }

    const wait =
      res.data.retryAfterMs !== null
        ? Math.min(Math.max(res.data.retryAfterMs, 0), RETRY_AFTER_CAP_MS)
        : progressed
          ? 0
          : IDLE_ROUND_DELAY_MS;
    if (wait > 0) await deps.sleep(wait, deps.signal);
  }
}

/** Resolves after `ms`, or right away when the signal aborts (the loop then checks it). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** null = no channel limit (the owner). */
export function remainingSlots(count: number, limit: number | null): number | null {
  return limit === null ? null : Math.max(0, limit - count);
}

/**
 * Adds `found` usernames (input order) to the selection while there is room. Run on every check
 * pass with only the newly found ones, so a reader's unchecks survive a «Проверить ещё раз».
 */
export function extendSelection(
  selected: ReadonlySet<string>,
  newlyFound: readonly string[],
  remaining: number | null,
): Set<string> {
  const next = new Set(selected);
  for (const username of newlyFound) {
    if (remaining !== null && next.size >= remaining) break;
    next.add(username);
  }
  return next;
}

export const foundUsernames = (items: readonly BulkItem[]): string[] =>
  items.filter(isSelectable).map((i) => i.username);

/** Selected usernames in input order; anything no longer selectable is dropped. */
export const selectedInOrder = (
  items: readonly BulkItem[],
  selected: ReadonlySet<string>,
): string[] => foundUsernames(items).filter((u) => selected.has(u));

export function toPickerItem(item: BulkItem, selected: ReadonlySet<string>): PickerItem {
  const selectable = isSelectable(item);
  return {
    key: item.username,
    title: item.title?.trim() || `@${item.username}`,
    subtitle: `@${item.username}`,
    avatarUrl: item.avatarUrl,
    status: t.bulk.status[item.status],
    selectable,
    selected: selectable && selected.has(item.username),
  };
}

export type AddButtonState =
  | { kind: 'add'; count: number }
  | { kind: 'hint'; remaining: number; limit: number }
  | { kind: 'none' };

/**
 * MainButton «Добавить N» only for 1 ≤ N ≤ remaining. A disabled MainButton looks enabled in
 * Telegram, so otherwise it is hidden and the screen says how many still fit.
 */
export function addButtonState(
  selectedCount: number,
  remaining: number | null,
  limit: number | null,
): AddButtonState {
  if (selectedCount >= 1 && (remaining === null || selectedCount <= remaining)) {
    return { kind: 'add', count: selectedCount };
  }
  if (remaining === null || limit === null) return { kind: 'none' };
  return { kind: 'hint', remaining, limit };
}

export function bulkOutcome(data: BulkAddResponse): { added: number; overLimit: number } {
  return {
    added: data.added,
    overLimit: data.results.filter((r) => r.status === 'limit').length,
  };
}

// The bulk screen hands its result to the channels screen it returns to. A plain module value:
// both screens live in one document, and the note is stale after a few seconds.
let flash: { text: string; at: number } | null = null;
const FLASH_TTL_MS = 10_000;

export function setBulkFlash(text: string, now = Date.now()): void {
  flash = { text, at: now };
}

/** Read without consuming (StrictMode runs initializers twice); clearBulkFlash after mount. */
export function peekBulkFlash(now = Date.now()): string | null {
  return flash && now - flash.at < FLASH_TTL_MS ? flash.text : null;
}

export function clearBulkFlash(): void {
  flash = null;
}
