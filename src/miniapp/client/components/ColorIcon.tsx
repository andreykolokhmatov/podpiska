import type { LucideIcon } from 'lucide-react';

/** Telegram-settings palette for cell icons. */
export const iconColors = {
  blue: '#007aff',
  orange: '#ff9500',
  green: '#34c759',
  purple: '#af52de',
  red: '#ff3b30',
  teal: '#30b0c7',
  indigo: '#5856d6',
  pink: '#ff2d55',
} as const;
export type IconColor = keyof typeof iconColors;

interface ColorIconProps {
  icon: LucideIcon;
  color: IconColor;
  /** square: solid tile with a white glyph (hub cells); round: tinted circle (onboarding). */
  shape?: 'square' | 'round';
  size?: number;
}

export function ColorIcon({ icon: Icon, color, shape = 'square', size = 30 }: ColorIconProps) {
  const value = iconColors[color];
  const round = shape === 'round';
  return (
    <span
      className={`pd-icon ${round ? 'pd-icon--round' : 'pd-icon--square'}`}
      style={{
        width: size,
        height: size,
        background: round ? `color-mix(in srgb, ${value} 16%, transparent)` : value,
        color: round ? value : '#fff',
      }}
      aria-hidden
    >
      <Icon size={Math.round(size * (round ? 0.5 : 0.6))} strokeWidth={2.2} />
    </span>
  );
}
