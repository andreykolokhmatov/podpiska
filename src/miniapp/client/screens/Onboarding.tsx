'use client';

import { Cell, Section } from '@telegram-apps/telegram-ui';
import { Newspaper, Radio, Sparkles, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { onboardingResponseSchema } from '@/miniapp/contract';

import { apiFetch, type ClientError } from '../api';
import { ColorIcon, type IconColor } from '../components/ColorIcon';
import { NewspaperEmoji } from '../components/NewspaperEmoji';
import { privacyUrl } from '../env';
import { useAppearance, useBackButton, useMainButton } from '../hooks';
import { haptic } from '../sdk';
import { errorText, t } from '../texts';

const BENEFIT_ICONS: Record<string, { icon: LucideIcon; color: IconColor }> = {
  channels: { icon: Radio, color: 'blue' },
  interests: { icon: Sparkles, color: 'orange' },
  paper: { icon: Newspaper, color: 'green' },
};

interface OnboardingProps {
  onDone: () => void;
}

export function Onboarding({ onDone }: OnboardingProps) {
  const appearance = useAppearance();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  useBackButton(null);
  useMainButton(
    { text: t.onboarding.start, enabled: !saving, loader: saving, shine: false },
    () => {
      if (saving) return;
      haptic.impact();
      setSaving(true);
      setError(null);
      void apiFetch('/api/app/onboarding', onboardingResponseSchema, { method: 'POST' }).then(
        (res) => {
          setSaving(false);
          if (res.ok) onDone();
          else {
            haptic.error();
            setError(res.error);
          }
        },
      );
    },
  );

  return (
    <main className="pd-page pd-onboarding">
      <header className="pd-hero">
        <NewspaperEmoji size={128} />
        <p className="pd-hero__accent">{t.onboarding.accent}</p>
        <h1 className="pd-hero__title">{t.onboarding.title}</h1>
      </header>
      <Section className="pd-benefits">
        {t.onboarding.benefits.map((benefit) => {
          const icon = BENEFIT_ICONS[benefit.id] ?? { icon: Newspaper, color: 'blue' };
          return (
            <Cell
              key={benefit.id}
              Component="div"
              before={<ColorIcon icon={icon.icon} color={icon.color} shape="round" size={44} />}
              subtitle={benefit.subtitle}
              multiline
            >
              {benefit.title}
            </Cell>
          );
        })}
      </Section>
      {error && (
        <p className="pd-message pd-message--error" role="alert">
          {errorText(error.error)}
        </p>
      )}
      <p className="pd-footnote">
        <a href={privacyUrl(appearance)}>{t.onboarding.privacy}</a>
      </p>
    </main>
  );
}
