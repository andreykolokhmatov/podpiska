'use client';

import { meResponseSchema } from '@/miniapp/contract';

import { apiFetch } from '../api';
import { useApi } from '../useApi';
import { Hub } from './Hub';
import { LoadError, Loading } from './LoadState';
import { Onboarding } from './Onboarding';

export function Home() {
  const { resource, reload, setData } = useApi(() => apiFetch('/api/app/me', meResponseSchema));

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;
  if (!resource.data.onboarded) {
    return <Onboarding onDone={() => setData((me) => ({ ...me, onboarded: true }))} />;
  }
  return <Hub me={resource.data} />;
}
