import type { LucideIcon } from 'lucide-react';

/** Telegram Settings palette: solid tiles, white glyphs. */
export const iconColors = {
  blue: '#007aff',
  sky: '#2aabee',
  orange: '#ff9500',
  red: '#ff3b30',
  pink: '#ff2d55',
  purple: '#af52de',
  green: '#34c759',
  grey: '#8e8e93',
} as const;
export type IconColor = keyof typeof iconColors;

interface ColorIconProps {
  icon: LucideIcon;
  color: IconColor;
  size?: number;
}

/** A Telegram-Settings icon: saturated rounded square (radius ≈ 23% of the side), white glyph. */
export function ColorIcon({ icon: Icon, color, size = 30 }: ColorIconProps) {
  return (
    <span
      className="pd-icon"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.233),
        background: iconColors[color],
      }}
      aria-hidden
    >
      <Icon size={Math.round(size * 0.6)} strokeWidth={2.2} color="#fff" />
    </span>
  );
}
