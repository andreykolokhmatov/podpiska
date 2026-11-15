'use client';

import {
  channelsResponseSchema,
  interestsResponseSchema,
  meResponseSchema,
  type ChannelView,
  type MeResponse,
} from '@/miniapp/contract';

import { apiFetch, type ApiResult } from '../api';
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
  const [me, channels, interests] = await Promise.all([
    apiFetch('/api/app/me', meResponseSchema),
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
  const { resource, reload, setData } = useApi(loadHome);

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;
  if (!resource.data.me.onboarded) {
    return (
      <Onboarding
        onDone={() => setData((data) => ({ ...data, me: { ...data.me, onboarded: true } }))}
      />
    );
  }
  return <Hub data={resource.data} />;
}
