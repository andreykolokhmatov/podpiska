'use client';

import { Chip, Section, Textarea } from '@telegram-apps/telegram-ui';
import { useState } from 'react';

import { INTERESTS_MAX, interestsResponseSchema } from '@/miniapp/contract';

import { apiFetch } from '../api';
import { useBackButton, useGoBack, useMainButton } from '../hooks';
import { appendInterest } from '../interests';
import { haptic } from '../sdk';
import { errorText, t } from '../texts';
import { useApi } from '../useApi';
import { LoadError, Loading } from './LoadState';

export function Interests() {
  const goBack = useGoBack();
  const { resource, reload } = useApi(() =>
    apiFetch('/api/app/interests', interestsResponseSchema),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = resource.status === 'ok' ? (resource.data.interests ?? '') : '';
  const value = draft ?? saved;
  const changed = value.trim() !== saved.trim();
  const tooLong = value.length > INTERESTS_MAX;

  const save = async () => {
    if (!changed || saving || tooLong) return;
    haptic.impact();
    setSaving(true);
    setError(null);
    const res = await apiFetch('/api/app/interests', interestsResponseSchema, {
      method: 'PUT',
      body: { interests: value },
    });
    setSaving(false);
    if (!res.ok) {
      haptic.error();
      setError(errorText(res.error.error));
      return;
    }
    haptic.success();
    goBack();
  };

  useBackButton(goBack);
  useMainButton(
    resource.status === 'ok'
      ? {
          text: t.interests.save,
          enabled: changed && !tooLong && !saving,
          loader: saving,
          shine: false,
        }
      : null,
    () => void save(),
  );

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <LoadError error={resource.error} onRetry={reload} />;

  return (
    <main className="pd-page">
      <Section
        className="pd-form-section"
        header={t.interests.header}
        footer={
          <div className="pd-section-note pd-section-note--split">
            <span
              className={error ? 'pd-error-text' : undefined}
              role={error ? 'alert' : undefined}
            >
              {error ?? t.interests.footer}
            </span>
            <span className={tooLong ? 'pd-error-text' : undefined}>
              {t.interests.counter(value.length)}
            </span>
          </div>
        }
      >
        <Textarea
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.interests.placeholder}
          aria-label={t.interests.header}
          maxLength={INTERESTS_MAX}
          rows={6}
          status={error || tooLong ? 'error' : 'default'}
          disabled={saving}
        />
      </Section>
      <Section header={t.interests.examplesHeader}>
        <div className="pd-chips">
          {t.interests.examples.map((example) => (
            <Chip
              key={example}
              mode="elevated"
              Component="button"
              type="button"
              onClick={() => {
                haptic.selection();
                setDraft(appendInterest(value, example));
              }}
            >
              {example}
            </Chip>
          ))}
        </div>
      </Section>
    </main>
  );
}
