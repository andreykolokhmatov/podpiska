'use client';

import {
  channelsResponseSchema,
  interestsResponseSchema,
  meResponseSchema,
  type ChannelView,
  type MeResponse,
} from '@/miniapp/contract';

import { useEffect } from 'react';

import { apiFetch, type ApiResult } from '../api';
import { clientTimeZone } from '../schedule';
import { useApi } from '../useApi';
import { Hub } from './Hub';
import { LoadError, Loading } from './LoadState';
import { Onboarding } from './Onboarding';

export interface HomeData {
  me: MeResponse;
  channels: ChannelView[];
  interests: string | null;
}

// The hub shows channels and interests inline; the contract keeps them on their own endpoints.
async function loadHome(): Promise<ApiResult<HomeData>> {
  const timeZone = clientTimeZone();
  const mePath = timeZone ? `/api/app/me?tz=${encodeURIComponent(timeZone)}` : '/api/app/me';
  const [me, channels, interests] = await Promise.all([
    apiFetch(mePath, meResponseSchema),
    apiFetch('/api/app/channels', channelsResponseSchema),
    apiFetch('/api/app/interests', interestsResponseSchema),
  ]);
  if (!me.ok) return me;
  if (!channels.ok) return channels;
  if (!interests.ok) return interests;
  return {
    ok: true,
    status: 200,
    data: { me: me.data, channels: channels.data.channels, interests: interests.data.interests },
  };
}

export function Home() {
  const { resource, loaded, refresh, reload, setData } = useApi(loadHome);

  // Back from the newspaper may restore the hub from bfcache, frozen on "opening the issue" and
  // without the new issue. Refetch, then remount the hub so its build state is seeded afresh.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
    // refresh only bumps a counter; one listener per mount is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;
  if (!resource.data.me.onboarded) {
    return (
      <Onboarding
        onDone={() => setData((data) => ({ ...data, me: { ...data.me, onboarded: true } }))}
      />
    );
  }
  return <Hub key={loaded} data={resource.data} />;
}
