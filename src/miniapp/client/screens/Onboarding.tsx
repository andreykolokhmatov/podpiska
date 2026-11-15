'use client';

import { Text, Title } from '@telegram-apps/telegram-ui';
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

const FEATURE_ICONS: Record<string, { icon: LucideIcon; color: IconColor }> = {
  channels: { icon: Radio, color: 'blue' },
  interests: { icon: Sparkles, color: 'orange' },
  paper: { icon: Newspaper, color: 'red' },
};

interface OnboardingProps {
  onDone: () => void;
}

/** Feature-intro screen (like Telegram's own Premium / Stories intros), not a list of cells. */
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
    <main className="pd-intro">
      <NewspaperEmoji size={144} />
      <Title level="1" weight="1" Component="h1" className="pd-intro__title">
        {t.onboarding.title}
      </Title>
      <Text className="pd-intro__text">{t.onboarding.text}</Text>
      <ul className="pd-intro__features">
        {t.onboarding.features.map((feature) => {
          const icon = FEATURE_ICONS[feature.id] ?? { icon: Newspaper, color: 'blue' };
          return (
            <li key={feature.id}>
              <ColorIcon icon={icon.icon} color={icon.color} size={26} />
              <Text>{feature.text}</Text>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="pd-message pd-message--error" role="alert">
          {errorText(error.error)}
        </p>
      )}
      <p className="pd-footnote pd-intro__privacy">
        <a href={privacyUrl(appearance)}>{t.onboarding.privacy}</a>
      </p>
    </main>
  );
}
