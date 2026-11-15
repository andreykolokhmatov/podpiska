'use client';

import { Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';

import { FREQUENCIES, scheduleResponseSchema, type ScheduleView } from '@/miniapp/contract';

import { apiFetch } from '../api';
import { useBackButton, useGoBack, useMainButton } from '../hooks';
import {
  clientTimeZone,
  draftFrom,
  HOURS,
  hourOption,
  sameDraft,
  scheduleNote,
  timeZoneName,
  type ScheduleDraft,
} from '../schedule';
import { askWriteAccess, haptic } from '../sdk';
import { errorText, t } from '../texts';
import { useApi } from '../useApi';
import { LoadError, Loading } from './LoadState';

export function ScheduleScreen() {
  const goBack = useGoBack();
  const { resource, loaded, reload, setData } = useApi(() =>
    apiFetch('/api/app/schedule', scheduleResponseSchema),
  );
  // Remounts the form after a save, so its draft is seeded from the saved view.
  const [saves, setSaves] = useState(0);

  useBackButton(goBack);

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;
  return (
    <ScheduleForm
      key={`${loaded}:${saves}`}
      view={resource.data.schedule}
      onSaved={(schedule) => {
        setData(() => ({ schedule }));
        setSaves((n) => n + 1);
      }}
    />
  );
}

interface ScheduleFormProps {
  view: ScheduleView;
  onSaved: (view: ScheduleView) => void;
}

function ScheduleForm({ view, onSaved }: ScheduleFormProps) {
  const saved = draftFrom(view);
  const [draft, setDraft] = useState<ScheduleDraft>(saved);
  const [granted, setGranted] = useState(false);
  const [asking, setAsking] = useState(false);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = !sameDraft(draft, saved);

  const update = (patch: Partial<ScheduleDraft>) => {
    haptic.selection();
    setError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const toggle = async (on: boolean) => {
    if (!on || view.canNotify || granted) {
      update({ enabled: on });
      return;
    }
    // The bot may not write to this user yet: ask Telegram first, the switch follows the answer.
    setAsking(true);
    const allowed = await askWriteAccess();
    setAsking(false);
    if (!allowed) {
      haptic.error();
      setDenied(true);
      return;
    }
    setGranted(true);
    setDenied(false);
    update({ enabled: true });
  };

  const save = async () => {
    if (!changed || saving) return;
    haptic.impact();
    setSaving(true);
    setError(null);
    const timeZone = clientTimeZone();
    const res = await apiFetch('/api/app/schedule', scheduleResponseSchema, {
      method: 'PUT',
      body: {
        enabled: draft.enabled,
        everyDays: draft.everyDays,
        hour: draft.hour,
        ...(timeZone ? { timeZone } : {}),
        ...(granted && draft.enabled ? { writeAccessGranted: true } : {}),
      },
    });
    setSaving(false);
    if (!res.ok) {
      haptic.error();
      setError(errorText(res.error.error));
      return;
    }
    haptic.success();
    onSaved(res.data.schedule);
  };

  useMainButton(
    changed ? { text: t.schedule.save, enabled: !saving, loader: saving, shine: false } : null,
    () => void save(),
  );

  let note: string | null = null;
  let noteClass = 'pd-section-note';
  if (error) {
    note = error;
    noteClass += ' pd-section-note--error';
  } else if (denied) {
    note = t.schedule.deniedNote;
  } else if (!changed) {
    note = scheduleNote(view);
  }

  const dimmed = draft.enabled ? undefined : 'pd-dimmed';

  return (
    <main className="pd-page">
      <Section
        footer={
          note ? (
            <p className={noteClass} role={error ? 'alert' : undefined}>
              {note}
            </p>
          ) : undefined
        }
      >
        <Cell
          Component="label"
          after={
            <Switch
              checked={draft.enabled}
              disabled={asking || saving}
              onChange={(e) => void toggle(e.target.checked)}
            />
          }
        >
          {t.schedule.switchLabel}
        </Cell>
      </Section>

      <Section header={t.schedule.frequencyHeader} className={dimmed}>
        {FREQUENCIES.map((everyDays) => (
          <Cell
            key={everyDays}
            role="radio"
            aria-checked={draft.everyDays === everyDays}
            after={
              draft.everyDays === everyDays ? (
                <Check className="pd-check" size={22} strokeWidth={2.4} />
              ) : undefined
            }
            onClick={() => update({ everyDays })}
          >
            {t.schedule.frequencies[everyDays]}
          </Cell>
        ))}
      </Section>

      <Section
        className={dimmed}
        footer={
          <p className="pd-section-note">{t.schedule.timeZone(timeZoneName(view.timeZone))}</p>
        }
      >
        <Cell
          Component="label"
          className="pd-select-cell"
          after={
            <span className="pd-select-value">
              {hourOption(draft.hour)}
              <ChevronsUpDown size={16} />
            </span>
          }
        >
          {t.schedule.time}
          <select
            className="pd-select-native"
            aria-label={t.schedule.time}
            value={draft.hour}
            onChange={(e) => update({ hour: Number(e.target.value) })}
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {hourOption(hour)}
              </option>
            ))}
          </select>
        </Cell>
      </Section>
    </main>
  );
}
