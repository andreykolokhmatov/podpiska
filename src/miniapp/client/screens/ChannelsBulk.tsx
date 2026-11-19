'use client';

import { ButtonCell, Cell, Section, Spinner, Textarea } from '@telegram-apps/telegram-ui';
import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { extractChannelCandidates } from '@/collector/extract';
import {
  BULK_CANDIDATES_MAX,
  BULK_TEXT_MAX,
  bulkAddResponseSchema,
  channelsResponseSchema,
  resolveChannelsResponseSchema,
} from '@/miniapp/contract';

import { apiFetch } from '../api';
import type { MainButtonView } from '../build';
import {
  abortableSleep,
  addButtonState,
  bulkOutcome,
  extendSelection,
  foundUsernames,
  hasRetryable,
  initialItems,
  progress,
  remainingSlots,
  requeue,
  runResolveLoop,
  selectedInOrder,
  setBulkFlash,
  toPickerItem,
  type BulkItem,
} from '../bulkAdd';
import { CandidateList } from '../components/CandidateList';
import { openedFromApp } from '../env';
import { useBackButton, useGoBack, useMainButton } from '../hooks';
import { haptic } from '../sdk';
import { errorText, t } from '../texts';
import { useApi } from '../useApi';
import { LoadError, Loading } from './LoadState';

type Step = 'paste' | 'checking' | 'preview' | 'committing';

interface ExtractMeta {
  skipped: number;
  truncated: boolean;
}

export function ChannelsBulk() {
  const goBack = useGoBack();
  const router = useRouter();
  const { resource, reload } = useApi(() => apiFetch('/api/app/channels', channelsResponseSchema));
  const [step, setStep] = useState<Step>('paste');
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<ExtractMeta>({ skipped: 0, truncated: false });
  const [items, setItems] = useState<BulkItem[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Leaving the screen stops the check loop and any commit still in flight.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const limit = resource.status === 'ok' ? resource.data.limit : null;
  const remaining =
    resource.status === 'ok' ? remainingSlots(resource.data.channels.length, limit) : null;

  const nextSignal = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  };

  const check = async (start: BulkItem[]) => {
    const before = new Set(foundUsernames(start));
    const signal = nextSignal();
    setStep('checking');
    setError(null);
    setItems(start);
    const result = await runResolveLoop(start, {
      resolve: (usernames, abort) =>
        apiFetch('/api/app/channels/resolve', resolveChannelsResponseSchema, {
          method: 'POST',
          body: { usernames },
          signal: abort,
        }),
      sleep: abortableSleep,
      onUpdate: setItems,
      signal,
    });
    if (result.aborted) return;
    const newlyFound = foundUsernames(result.items).filter((u) => !before.has(u));
    setSelected((current) => extendSelection(current, newlyFound, remaining));
    if (result.error) {
      haptic.error();
      setError(errorText(result.error.error, result.error.limit));
    } else {
      haptic.success();
    }
    setStep('preview');
  };

  const find = () => {
    const extracted = extractChannelCandidates(text, { maxCandidates: BULK_CANDIDATES_MAX });
    setMeta({ skipped: extracted.skipped, truncated: extracted.truncated });
    if (extracted.candidates.length === 0) {
      haptic.error();
      setNote(t.bulk.nothingFound);
      return;
    }
    haptic.impact();
    setNote(null);
    setSelected(new Set());
    void check(initialItems(extracted));
  };

  const leaveToChannels = () => {
    if (openedFromApp(window.location.search)) router.back();
    else router.replace('/channels');
  };

  const commit = async () => {
    const usernames = selectedInOrder(items, selected);
    if (usernames.length === 0) return;
    haptic.impact();
    setStep('committing');
    setError(null);
    const res = await apiFetch('/api/app/channels/bulk', bulkAddResponseSchema, {
      method: 'POST',
      body: { usernames },
      signal: nextSignal(),
    });
    if (controllerRef.current?.signal.aborted) return;
    if (!res.ok) {
      haptic.error();
      setError(errorText(res.error.error, res.error.limit));
      setStep('preview');
      return;
    }
    haptic.success();
    const { added, overLimit } = bulkOutcome(res.data);
    const parts = [added > 0 ? t.bulk.added(added) : t.bulk.noneAdded];
    if (overLimit > 0) parts.push(t.bulk.overLimit(overLimit));
    setBulkFlash(parts.join(', '));
    leaveToChannels();
  };

  const toggle = (key: string) => {
    haptic.selection();
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = (all: boolean) => {
    haptic.selection();
    setSelected(all ? new Set(foundUsernames(items)) : new Set());
  };

  const selectedCount = selectedInOrder(items, selected).length;
  const addState = addButtonState(selectedCount, remaining, limit);

  useBackButton(() => {
    controllerRef.current?.abort();
    goBack();
  });
  useMainButton(
    mainButtonView(step, resource.status === 'ok' && text.trim() !== '', addState, selectedCount),
    () => {
      if (step === 'paste') find();
      else if (step === 'preview') void commit();
    },
  );

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;

  if (step === 'paste') {
    return (
      <main className="pd-page">
        <Section
          className="pd-form-section"
          header={t.bulk.pasteHeader}
          footer={
            <p
              className={`pd-section-note${note ? ' pd-section-note--error' : ''}`}
              role={note ? 'alert' : undefined}
            >
              {note
                ? [note, meta.skipped > 0 ? t.bulk.skipped(meta.skipped) : null]
                    .filter(Boolean)
                    .join(' ')
                : t.bulk.pasteFooter}
            </p>
          }
        >
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (note) setNote(null);
            }}
            placeholder={t.bulk.placeholder}
            aria-label={t.bulk.pasteHeader}
            maxLength={BULK_TEXT_MAX}
            rows={8}
            status={note ? 'error' : 'default'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Section>
      </main>
    );
  }

  const { done, total } = progress(items);
  const checking = step === 'checking';
  const footer = [
    meta.skipped > 0 ? t.bulk.skipped(meta.skipped) : null,
    meta.truncated ? t.bulk.truncated : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <main className="pd-page">
      <Section header={t.bulk.checkingHeader}>
        <Cell
          Component="div"
          before={
            checking ? (
              <span className="pd-status-spinner">
                <Spinner size="s" />
              </span>
            ) : undefined
          }
          subtitle={
            !checking && addState.kind === 'hint'
              ? t.bulk.canAdd(addState.remaining, addState.limit)
              : undefined
          }
          multiline
        >
          <span className="pd-progress">{t.bulk.checked(done, total)}</span>
        </Cell>
        {step === 'preview' && hasRetryable(items) && (
          <ButtonCell
            className="pd-button-cell"
            before={
              <span className="pd-add-icon">
                <RotateCw size={20} strokeWidth={2.4} />
              </span>
            }
            onClick={() => {
              haptic.impact();
              void check(requeue(items));
            }}
          >
            {t.bulk.retry}
          </ButtonCell>
        )}
      </Section>
      {error && (
        <p className="pd-footnote pd-error-text" role="alert">
          {error}
        </p>
      )}
      <CandidateList
        items={items.map((item) => toPickerItem(item, selected))}
        header={t.bulk.listHeader(items.length)}
        footer={footer ? <p className="pd-section-note">{footer}</p> : undefined}
        onToggle={toggle}
        onSelectAll={step === 'preview' ? selectAll : undefined}
        disabled={step !== 'preview'}
      />
    </main>
  );
}

function mainButtonView(
  step: Step,
  canFind: boolean,
  addState: ReturnType<typeof addButtonState>,
  selectedCount: number,
): MainButtonView | null {
  switch (step) {
    case 'paste':
      return canFind ? { text: t.bulk.find, enabled: true, loader: false, shine: false } : null;
    case 'checking':
      return null;
    case 'preview':
      return addState.kind === 'add'
        ? { text: t.bulk.add(addState.count), enabled: true, loader: false, shine: false }
        : null;
    case 'committing':
      return { text: t.bulk.add(selectedCount), enabled: false, loader: true, shine: false };
  }
}
