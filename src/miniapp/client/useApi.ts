'use client';

import { useEffect, useState } from 'react';

import type { ApiResult, ClientError } from './api';

export type Resource<T> =
  { status: 'loading' } | { status: 'error'; error: ClientError } | { status: 'ok'; data: T };

/**
 * Loads one API resource on mount. No query library is installed; screens are small and every
 * mutation updates the local copy through `setData`.
 */
export function useApi<T>(load: () => Promise<ApiResult<T>>) {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    void load().then((res) => {
      if (!alive) return;
      setResource(
        res.ok ? { status: 'ok', data: res.data } : { status: 'error', error: res.error },
      );
    });
    return () => {
      alive = false;
    };
    // `load` is a fresh closure every render; refetching is driven by `attempt` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return {
    resource,
    reload: () => {
      setResource({ status: 'loading' });
      setAttempt((n) => n + 1);
    },
    setData: (update: (data: T) => T) =>
      setResource((current) =>
        current.status === 'ok' ? { status: 'ok', data: update(current.data) } : current,
      ),
  };
}
