import type { IssueErrorCode, IssueState, Quota } from '@/miniapp/contract';

import { apiErrorText, issueFailureText, t, type ClientErrorCode } from './texts';

/** Poll every 2s for the first minute, then every 5s; give up showing progress after 6 minutes. */
export const POLL_FAST_MS = 2_000;
export const POLL_SLOW_MS = 5_000;
export const POLL_FAST_FOR_MS = 60_000;
export const SLOW_AFTER_MS = 6 * 60_000;

export type BuildFailure =
  | { source: 'issue'; code: IssueErrorCode; found?: IssueState['found'] }
  | { source: 'api'; code: ClientErrorCode };

export type BuildState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'polling';
      issueId: string;
      since: number;
      issue: IssueState | null;
      /** Bumped on every poll answer so the poll loop re-arms even when nothing changed. */
      polls: number;
    }
  | { kind: 'ready'; issueId: string }
  | { kind: 'failed'; failure: BuildFailure }
  | { kind: 'slow'; issueId: string };

export type BuildEvent =
  | { type: 'start' }
  /** An in-flight issue found on load (me.inFlight): resume polling it. */
  | { type: 'resume'; issue: IssueState; now: number }
  | { type: 'started'; issue: IssueState; now: number }
  /** 409: another build is running; poll that one instead. */
  | { type: 'busy'; issueId: string; now: number }
  | { type: 'rejected'; code: ClientErrorCode }
  | { type: 'polled'; issue: IssueState; now: number }
  | { type: 'pollFailed'; code: ClientErrorCode; now: number };

export const initialBuildState: BuildState = { kind: 'idle' };

/** Poll errors that will not go away by retrying: stop and explain. */
const FATAL_POLL_ERRORS: ReadonlySet<ClientErrorCode> = new Set([
  'unauthorized',
  'expired',
  'not_found',
  'bad_request',
]);

const isBusy = (state: BuildState) => state.kind === 'starting' || state.kind === 'polling';

function applyIssue(
  issue: IssueState,
  issueId: string,
  since: number,
  now: number,
  polls = 0,
): BuildState {
  if (issue.status === 'ready') return { kind: 'ready', issueId };
  if (issue.status === 'failed') {
    const failure: BuildFailure = { source: 'issue', code: issue.error ?? 'internal' };
    if (issue.found) failure.found = issue.found;
    return { kind: 'failed', failure };
  }
  if (now - since >= SLOW_AFTER_MS) return { kind: 'slow', issueId };
  return { kind: 'polling', issueId, since, issue, polls };
}

export function buildReducer(state: BuildState, event: BuildEvent): BuildState {
  switch (event.type) {
    case 'start':
      return isBusy(state) ? state : { kind: 'starting' };
    case 'resume':
      if (isBusy(state)) return state;
      return applyIssue(event.issue, event.issue.id, event.now, event.now);
    case 'started':
      if (state.kind !== 'starting') return state;
      return applyIssue(event.issue, event.issue.id, event.now, event.now);
    case 'busy':
      if (state.kind !== 'starting') return state;
      return { kind: 'polling', issueId: event.issueId, since: event.now, issue: null, polls: 0 };
    case 'rejected':
      if (state.kind !== 'starting') return state;
      return { kind: 'failed', failure: { source: 'api', code: event.code } };
    case 'polled':
      if (state.kind !== 'polling' || state.issueId !== event.issue.id) return state;
      return applyIssue(event.issue, state.issueId, state.since, event.now, state.polls + 1);
    case 'pollFailed':
      if (state.kind !== 'polling') return state;
      if (FATAL_POLL_ERRORS.has(event.code)) {
        return { kind: 'failed', failure: { source: 'api', code: event.code } };
      }
      // Transient (network / 5xx): keep polling until the slow cut-off.
      if (event.now - state.since >= SLOW_AFTER_MS) return { kind: 'slow', issueId: state.issueId };
      return { ...state, polls: state.polls + 1 };
  }
}

/** Delay before the next poll, or null when not polling. */
export function nextPollDelay(state: BuildState, now: number): number | null {
  if (state.kind !== 'polling') return null;
  return now - state.since < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

export function progressLabel(issue: IssueState | null): string {
  const progress = issue?.progress;
  if (!progress || progress.step === 'collecting') return t.progress.collecting;
  if (progress.step === 'composing') return t.progress.composing;
  const { done, total } = progress;
  return done !== null && total !== null && total > 0
    ? t.progress.digestingCounted(Math.min(done, total), total)
    : t.progress.digesting;
}

export interface MainButtonView {
  text: string;
  enabled: boolean;
  loader: boolean;
  shine: boolean;
}

export interface BuildContext {
  channelCount: number;
  /** null for the owner (no quota). */
  quota: Quota | null;
}

export const canBuild = ({ channelCount, quota }: BuildContext): boolean =>
  channelCount > 0 && (quota === null || quota.remaining > 0);

/** What the native MainButton shows on the hub for a given build state. */
export function buildButtonView(state: BuildState, ctx: BuildContext): MainButtonView {
  switch (state.kind) {
    case 'starting':
      return { text: t.hub.build, enabled: false, loader: true, shine: false };
    case 'polling':
      // Looks active (a greyed button reads as "broken"); taps are ignored while polling.
      return { text: progressLabel(state.issue), enabled: true, loader: false, shine: true };
    case 'ready':
      return { text: t.hub.build, enabled: false, loader: true, shine: false };
    default:
      return { text: t.hub.build, enabled: canBuild(ctx), loader: false, shine: false };
  }
}

/** Footer under the issue section; null for the owner (no quota). */
export function quotaText(quota: Quota | null): string | null {
  if (quota === null) return null;
  return quota.remaining > 0 ? t.hub.quotaLeft(quota.remaining) : t.hub.quotaNone;
}

/** Russian text for a failed build; channelCount = channels in the subscription now. */
export function failureText(failure: BuildFailure, channelCount: number): string {
  return failure.source === 'issue'
    ? issueFailureText(failure.code, failure.found, channelCount)
    : apiErrorText[failure.code];
}
