'use client';

import { Cell, IconButton, Section, Spinner } from '@telegram-apps/telegram-ui';
import { Archive, ChevronRight, CircleAlert, Hourglass, Plus, Radio, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { MeResponse } from '@/miniapp/contract';

import {
  buildButtonView,
  deriveChecklist,
  failureText,
  progressLabel,
  quotaText,
  type BuildState,
} from '../build';
import { Checklist } from '../components/Checklist';
import { ColorIcon } from '../components/ColorIcon';
import { IssueCard } from '../components/IssueCard';
import { UserAvatar } from '../components/UserAvatar';
import { issueUrl } from '../env';
import { useAppearance, useBackButton, useMainButton, useTma } from '../hooks';
import { navigateFull } from '../sdk';
import { t } from '../texts';
import { useIssueBuild } from '../useIssueBuild';

interface HubProps {
  me: MeResponse;
}

const chevron = <ChevronRight className="pd-chevron" size={20} />;

export function Hub({ me }: HubProps) {
  const router = useRouter();
  const { user } = useTma();
  const appearance = useAppearance();
  const [quota, setQuota] = useState(me.quota);
  const openIssue = (id: string) => navigateFull(issueUrl(id, appearance));

  const { state, start } = useIssueBuild({
    inFlight: me.inFlight,
    onReady: openIssue,
    onQuota: setQuota,
  });

  useBackButton(null);
  useMainButton(buildButtonView(state, { channelCount: me.channels.count, quota }), () => {
    void start();
  });

  const steps = deriveChecklist({
    channelCount: me.channels.count,
    hasInterests: me.hasInterests,
    hasIssue: me.latestIssue !== null,
  });
  const quotaLine = quotaText(quota);

  return (
    <main className="pd-page pd-hub">
      <header className="pd-hub__header">
        <UserAvatar user={user} />
        <h1 className="pd-hub__title">{t.appName}</h1>
        <IconButton
          mode="bezeled"
          size="m"
          className="pd-round-button"
          aria-label={t.hub.add}
          onClick={() => router.push('/channels?add=1')}
        >
          <Plus size={22} strokeWidth={2.4} />
        </IconButton>
      </header>

      <BuildStatus state={state} />

      {steps && (
        <Checklist
          steps={steps}
          onStep={(id) => router.push(id === 'channels' ? '/channels?add=1' : '/interests')}
        />
      )}

      {me.latestIssue && <IssueCard issue={me.latestIssue} onOpen={openIssue} />}

      <Section header={t.hub.menuHeader}>
        <Cell
          before={<ColorIcon icon={Radio} color="blue" />}
          after={
            <span className="pd-after">
              {me.channels.count > 0 && (
                <span className="pd-after__value">{me.channels.count}</span>
              )}
              {chevron}
            </span>
          }
          subtitle={me.channels.count === 0 ? t.hub.channelsEmpty : undefined}
          onClick={() => router.push('/channels')}
        >
          {t.hub.channels}
        </Cell>
        <Cell
          before={<ColorIcon icon={Sparkles} color="orange" />}
          after={chevron}
          subtitle={me.hasInterests ? t.hub.interestsSet : t.hub.interestsEmpty}
          onClick={() => router.push('/interests')}
        >
          {t.hub.interests}
        </Cell>
        <Cell
          before={<ColorIcon icon={Archive} color="purple" />}
          after={chevron}
          subtitle={t.hub.archiveSubtitle}
          onClick={() => router.push('/archive')}
        >
          {t.hub.archive}
        </Cell>
      </Section>

      {quotaLine && <p className="pd-footnote">{quotaLine}</p>}
    </main>
  );
}

function BuildStatus({ state }: { state: BuildState }) {
  switch (state.kind) {
    case 'starting':
    case 'polling':
      return (
        <Section>
          <Cell
            Component="div"
            before={
              <span className="pd-status-spinner">
                <Spinner size="s" />
              </span>
            }
            subtitle={t.hub.buildingSubtitle}
            multiline
          >
            {state.kind === 'polling' ? progressLabel(state.issue) : t.hub.buildingTitle}
          </Cell>
        </Section>
      );
    case 'ready':
      return (
        <Section>
          <Cell Component="div" before={<Spinner size="s" />} subtitle={t.hub.openingSubtitle}>
            {t.hub.openingTitle}
          </Cell>
        </Section>
      );
    case 'failed':
      return (
        <Section>
          <Cell
            Component="div"
            before={<ColorIcon icon={CircleAlert} color="red" />}
            subtitle={failureText(state.failure)}
            multiline
          >
            {t.hub.failedTitle}
          </Cell>
        </Section>
      );
    case 'slow':
      return (
        <Section>
          <Cell
            Component="div"
            before={<ColorIcon icon={Hourglass} color="orange" />}
            subtitle={t.hub.slowSubtitle}
            multiline
          >
            {t.hub.slowTitle}
          </Cell>
        </Section>
      );
    case 'idle':
      return null;
  }
}
