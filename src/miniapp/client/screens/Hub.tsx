'use client';

import {
  Avatar,
  ButtonCell,
  Cell,
  Placeholder,
  Section,
  Spinner,
} from '@telegram-apps/telegram-ui';
import {
  Archive,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  Hourglass,
  Plus,
  RotateCw,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  buildButtonView,
  canBuild,
  failureText,
  progressLabel,
  quotaText,
  type BuildState,
} from '../build';
import { ColorIcon } from '../components/ColorIcon';
import { IssueCard } from '../components/IssueCard';
import { NewspaperEmoji } from '../components/NewspaperEmoji';
import { initials, issueUrl } from '../env';
import { useAppearance, useBackButton, useMainButton } from '../hooks';
import { nextIssueLine } from '../schedule';
import { navigateFull } from '../sdk';
import { t } from '../texts';
import { useIssueBuild } from '../useIssueBuild';
import type { HomeData } from './Home';

const CHANNELS_INLINE = 5;

interface HubProps {
  data: HomeData;
}

const chevron = <ChevronRight className="pd-chevron" size={20} />;

export function Hub({ data }: HubProps) {
  const { me, channels, interests } = data;
  const router = useRouter();
  const appearance = useAppearance();
  const [quota, setQuota] = useState(me.quota);
  const openIssue = (id: string) => navigateFull(issueUrl(id, appearance));
  const channelCount = channels.length;

  const { state, start } = useIssueBuild({
    inFlight: me.inFlight,
    onReady: openIssue,
    onQuota: setQuota,
  });

  // With an issue on the hub the build is a quiet ButtonCell; the MainButton is for the first one.
  const hasIssue = me.latestIssue !== null;
  const buildable = canBuild({ channelCount, quota });
  const building = state.kind === 'starting' || state.kind === 'polling' || state.kind === 'ready';

  useBackButton(null);
  useMainButton(hasIssue ? null : buildButtonView(state, { channelCount, quota }), () => {
    void start();
  });

  const issueFooter = channelCount === 0 ? t.hub.needChannels : quotaText(quota);
  const status = <BuildStatus state={state} channelCount={channelCount} />;

  return (
    <main className="pd-page">
      <h1 className="pd-large-title">{t.hub.title}</h1>

      <Section header={t.schedule.hubHeader}>
        <Cell
          className="pd-icon-cell"
          before={<ColorIcon icon={CalendarClock} color="orange" size={40} />}
          after={chevron}
          onClick={() => router.push('/schedule')}
        >
          {nextIssueLine(me.schedule)}
        </Cell>
      </Section>

      {me.latestIssue ? (
        <Section header={t.hub.latestHeader} footer={issueFooter ?? undefined}>
          {status}
          <IssueCard issue={me.latestIssue} onOpen={openIssue} />
          {!building && (
            <ButtonCell
              before={
                <span className="pd-add-icon">
                  <RotateCw size={20} strokeWidth={2.4} />
                </span>
              }
              disabled={!buildable}
              className={buildable ? 'pd-button-cell' : 'pd-button-cell pd-dimmed'}
              onClick={() => void start()}
            >
              {t.hub.buildNow}
            </ButtonCell>
          )}
        </Section>
      ) : (
        <>
          {state.kind === 'idle' ? (
            <Placeholder
              className="pd-empty"
              header={t.hub.emptyTitle}
              description={channelCount === 0 ? t.hub.emptyNoChannels : t.hub.emptyReady}
            >
              <NewspaperEmoji size={112} />
            </Placeholder>
          ) : (
            <Section>{status}</Section>
          )}
          {channelCount > 0 && issueFooter && <p className="pd-footnote">{issueFooter}</p>}
        </>
      )}

      <Section
        header={t.hub.channelsHeader(channelCount)}
        footer={channelCount === 0 ? t.hub.channelsFooter : undefined}
      >
        <ButtonCell
          className="pd-button-cell"
          before={
            <span className="pd-add-icon">
              <Plus size={22} strokeWidth={2.4} />
            </span>
          }
          onClick={() => router.push('/channels?add=1')}
        >
          {t.hub.addChannel}
        </ButtonCell>
        {channels.slice(0, CHANNELS_INLINE).map((channel) => (
          <Cell
            key={channel.username}
            before={
              <Avatar
                size={40}
                src={channel.avatarUrl ?? undefined}
                referrerPolicy="no-referrer"
                acronym={initials(channel.title ?? channel.username)}
              />
            }
            subtitle={`@${channel.username}`}
            onClick={() => router.push('/channels')}
          >
            {channel.title?.trim() || `@${channel.username}`}
          </Cell>
        ))}
        {channelCount > CHANNELS_INLINE && (
          <ButtonCell className="pd-button-cell" onClick={() => router.push('/channels')}>
            {t.hub.showAll(channelCount)}
          </ButtonCell>
        )}
      </Section>

      <Section header={t.hub.interestsHeader} footer={t.hub.interestsFooter}>
        <Cell
          after={chevron}
          multiline
          subtitle={interests ? undefined : t.hub.interestsEmptyHint}
          onClick={() => router.push('/interests')}
        >
          {interests ? (
            <span className="pd-preview">{interests}</span>
          ) : (
            <span className="pd-muted">{t.hub.interestsEmpty}</span>
          )}
        </Cell>
      </Section>

      <Section>
        <Cell
          className="pd-icon-cell"
          before={<ColorIcon icon={Archive} color="purple" size={40} />}
          after={chevron}
          onClick={() => router.push('/archive')}
        >
          {t.hub.archive}
        </Cell>
      </Section>
    </main>
  );
}

function BuildStatus({ state, channelCount }: { state: BuildState; channelCount: number }) {
  switch (state.kind) {
    case 'starting':
    case 'polling':
      return (
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
      );
    case 'ready':
      return (
        <Cell
          Component="div"
          before={
            <span className="pd-status-spinner">
              <Spinner size="s" />
            </span>
          }
          subtitle={t.hub.openingSubtitle}
        >
          {t.hub.openingTitle}
        </Cell>
      );
    case 'failed':
      return (
        <Cell
          Component="div"
          before={<ColorIcon icon={CircleAlert} color="red" size={40} />}
          subtitle={failureText(state.failure, channelCount)}
          multiline
        >
          {t.hub.failedTitle}
        </Cell>
      );
    case 'slow':
      return (
        <Cell
          Component="div"
          before={<ColorIcon icon={Hourglass} color="orange" size={40} />}
          subtitle={t.hub.slowSubtitle}
          multiline
        >
          {t.hub.slowTitle}
        </Cell>
      );
    case 'idle':
      return null;
  }
}
