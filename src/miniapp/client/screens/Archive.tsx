'use client';

import { ButtonCell, Cell, Placeholder, Section, Spinner } from '@telegram-apps/telegram-ui';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  deleteIssueResponseSchema,
  issuesResponseSchema,
  type IssueSummary,
} from '@/miniapp/contract';

import { apiFetch } from '../api';
import { ColorIcon } from '../components/ColorIcon';
import { issueUrl } from '../env';
import { useAppearance, useBackButton, useGoBack, useMainButton } from '../hooks';
import { confirmDestructive, haptic, navigateFull } from '../sdk';
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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const remove = async (issue: IssueSummary) => {
    if (deleting !== null) return;
    haptic.selection();
    const ok = await confirmDestructive(
      t.archive.deleteTitle(issue.number),
      t.archive.deleteText,
      t.archive.deleteConfirm,
    );
    if (!ok) return;
    setDeleting(issue.id);
    setDeleteError(null);
    const res = await apiFetch(
      `/api/app/issues/${encodeURIComponent(issue.id)}`,
      deleteIssueResponseSchema,
      { method: 'DELETE' },
    );
    setDeleting(null);
    // not_found: already gone (another device, or deleted twice) – the row should vanish anyway.
    if (!res.ok && res.error.error !== 'not_found') {
      haptic.error();
      setDeleteError(
        res.error.error === 'busy' ? t.archive.deleteBusy : errorText(res.error.error),
      );
      return;
    }
    haptic.success();
    setData((data) => ({ ...data, issues: data.issues.filter((i) => i.id !== issue.id) }));
    // Every loaded row is gone but older pages exist: fetch them instead of showing "empty".
    if (resource.status === 'ok') {
      const { issues: loaded, nextBefore: more } = resource.data;
      if (more !== null && loaded.every((i) => i.id === issue.id)) void loadMore(more);
    }
  };

  const toggleEditing = () => {
    haptic.selection();
    setEditing((value) => !value);
    setDeleteError(null);
  };

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;
  const { issues, nextBefore } = resource.data;

  if (issues.length === 0 && loadingMore) return <Loading />;
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

  const footer = deleteError ?? moreError ?? (editing ? t.archive.editFooter : undefined);

  return (
    <main className="pd-page">
      <Section
        header={
          <Section.Header className="pd-section-head">
            <span>{t.archive.header}</span>
            <button type="button" className="pd-text-button" onClick={toggleEditing}>
              {editing ? t.archive.done : t.archive.edit}
            </button>
          </Section.Header>
        }
        footer={footer}
      >
        {issues.map((issue) => (
          <Cell
            key={issue.id}
            before={
              editing ? (
                deleting === issue.id ? (
                  <span className="pd-status-spinner">
                    <Spinner size="s" />
                  </span>
                ) : (
                  <ColorIcon icon={Trash2} color="red" />
                )
              ) : undefined
            }
            subhead={t.issueMeta(issue.number, issue.dateline)}
            after={editing ? undefined : <ChevronRight className="pd-chevron" size={20} />}
            multiline
            aria-label={editing ? t.archive.deleteLabel(issue.number) : undefined}
            disabled={deleting !== null}
            onClick={() =>
              editing ? void remove(issue) : navigateFull(issueUrl(issue.id, appearance))
            }
          >
            <span className="pd-headline">{issue.headline ?? t.issueTitle(issue.number)}</span>
          </Cell>
        ))}
        {nextBefore !== null && !editing && (
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
