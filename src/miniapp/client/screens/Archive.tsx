'use client';

import { ButtonCell, Cell, Placeholder, Section, Spinner } from '@telegram-apps/telegram-ui';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { issuesResponseSchema } from '@/miniapp/contract';

import { apiFetch } from '../api';
import { issueUrl } from '../env';
import { useAppearance, useBackButton, useGoBack, useMainButton } from '../hooks';
import { navigateFull } from '../sdk';
import { errorText, t } from '../texts';
import { useApi } from '../useApi';
import { LoadError, Loading } from './LoadState';

export function ArchiveScreen() {
  const goBack = useGoBack();
  const appearance = useAppearance();
  const { resource, reload, setData } = useApi(() =>
    apiFetch('/api/app/issues', issuesResponseSchema),
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  useBackButton(goBack);
  useMainButton(null, () => {});

  const loadMore = async (before: number) => {
    setLoadingMore(true);
    setMoreError(null);
    const res = await apiFetch(`/api/app/issues?before=${before}`, issuesResponseSchema);
    setLoadingMore(false);
    if (!res.ok) {
      setMoreError(errorText(res.error.error));
      return;
    }
    setData((data) => ({
      issues: [
        ...data.issues,
        ...res.data.issues.filter((i) => !data.issues.some((d) => d.id === i.id)),
      ],
      nextBefore: res.data.nextBefore,
    }));
  };

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;
  const { issues, nextBefore } = resource.data;

  if (issues.length === 0) {
    return (
      <main className="pd-page pd-center">
        <Placeholder header={t.archive.emptyTitle} description={t.archive.emptyText}>
          <span className="pd-outside__emoji" aria-hidden>
            🗞️
          </span>
        </Placeholder>
      </main>
    );
  }

  return (
    <main className="pd-page">
      <Section header={t.archive.header} footer={moreError ?? undefined}>
        {issues.map((issue) => (
          <Cell
            key={issue.id}
            subhead={t.issueMeta(issue.number, issue.dateline)}
            after={<ChevronRight className="pd-chevron" size={20} />}
            multiline
            onClick={() => navigateFull(issueUrl(issue.id, appearance))}
          >
            <span className="pd-headline">{issue.headline ?? t.issueTitle(issue.number)}</span>
          </Cell>
        ))}
        {nextBefore !== null && (
          <ButtonCell
            disabled={loadingMore}
            before={loadingMore ? <Spinner size="s" /> : undefined}
            onClick={() => void loadMore(nextBefore)}
          >
            {t.archive.more}
          </ButtonCell>
        )}
      </Section>
    </main>
  );
}
