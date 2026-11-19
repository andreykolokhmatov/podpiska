'use client';

import { useEffect, useEffectEvent, useReducer, useRef } from 'react';

import {
  buildResponseSchema,
  issueResponseSchema,
  meResponseSchema,
  type IssueState,
  type Quota,
} from '@/miniapp/contract';
import { QUOTA_EXEMPT_CODES } from '@/miniapp/status';

import { apiFetch } from './api';
import { buildReducer, initialBuildState, nextPollDelay, type BuildState } from './build';
import { haptic } from './sdk';

interface UseIssueBuildOptions {
  /** me.inFlight: a build already running when the hub opened. */
  inFlight: IssueState | null;
  onReady: (issueId: string) => void;
  onQuota: (quota: Quota | null) => void;
}

export function useIssueBuild({ inFlight, onReady, onQuota }: UseIssueBuildOptions) {
  const [state, dispatch] = useReducer(buildReducer, inFlight, (issue): BuildState =>
    issue
      ? buildReducer(initialBuildState, { type: 'resume', issue, now: Date.now() })
      : initialBuildState,
  );

  useEffect(() => {
    if (state.kind !== 'polling') return;
    const { issueId } = state;
    let cancelled = false;

    const poll = async () => {
      if (document.hidden) {
        document.addEventListener('visibilitychange', onVisible, { once: true });
        return;
      }
      const res = await apiFetch(
        `/api/app/issues/${encodeURIComponent(issueId)}`,
        issueResponseSchema,
      );
      if (cancelled) return;
      dispatch(
        res.ok
          ? { type: 'polled', issue: res.data.issue, now: Date.now() }
          : { type: 'pollFailed', code: res.error.error, now: Date.now() },
      );
    };
    const onVisible = () => {
      if (!cancelled) void poll();
    };
    const timer = setTimeout(() => void poll(), nextPollDelay(state, Date.now()) ?? 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state]);

  const readyId = state.kind === 'ready' ? state.issueId : null;
  useEffect(() => {
    if (readyId === null) return;
    haptic.success();
    onReady(readyId);
    // onReady is a navigation callback; firing once per ready issue is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyId]);

  const failed = state.kind === 'failed';
  useEffect(() => {
    if (failed) haptic.error();
  }, [failed]);

  // The quota shown was taken from the POST answer; an exempt failure gives that build back.
  const exemptFailure =
    state.kind === 'failed' &&
    state.failure.source === 'issue' &&
    QUOTA_EXEMPT_CODES.includes(state.failure.code);
  const syncQuota = useEffectEvent((quota: Quota | null) => onQuota(quota));
  useEffect(() => {
    if (!exemptFailure) return;
    let alive = true;
    void apiFetch('/api/app/me', meResponseSchema).then((res) => {
      if (alive && res.ok) syncQuota(res.data.quota);
    });
    return () => {
      alive = false;
    };
  }, [exemptFailure]);

  // A double tap fires twice before the 'starting' render lands; the ref sees the first at once.
  const posting = useRef(false);
  const start = async () => {
    if (posting.current) return;
    if (state.kind === 'starting' || state.kind === 'polling' || state.kind === 'ready') return;
    posting.current = true;
    try {
      await post();
    } finally {
      posting.current = false;
    }
  };

  const post = async () => {
    haptic.impact();
    dispatch({ type: 'start' });
    const res = await apiFetch('/api/app/issues', buildResponseSchema, { method: 'POST' });
    if (res.ok) {
      onQuota(res.data.quota);
      dispatch({ type: 'started', issue: res.data.issue, now: Date.now() });
      return;
    }
    const { error, issueId, quota } = res.error;
    if (error === 'busy' && issueId) {
      dispatch({ type: 'busy', issueId, now: Date.now() });
      return;
    }
    if (quota) onQuota(quota);
    dispatch({ type: 'rejected', code: error });
  };

  return { state, start };
}
