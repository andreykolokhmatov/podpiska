'use client';

import type { AnimationItem } from 'lottie-web';
import { useEffect, useRef, useState } from 'react';

interface NewspaperEmojiProps {
  size?: number;
}

/** Telegram's animated 📰, proxied by /api/emoji/newspaper; any failure keeps the static emoji. */
export function NewspaperEmoji({ size = 128 }: NewspaperEmojiProps) {
  const container = useRef<HTMLDivElement>(null);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    let animation: AnimationItem | undefined;

    void (async () => {
      try {
        const [res, lottie] = await Promise.all([
          fetch('/api/emoji/newspaper'),
          import('lottie-web/build/player/lottie_light'),
        ]);
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (cancelled || !container.current || typeof data !== 'object' || data === null) return;
        animation = lottie.default.loadAnimation({
          container: container.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: data,
        });
        animation.addEventListener('DOMLoaded', () => {
          if (!cancelled) setAnimated(true);
        });
        animation.addEventListener('data_failed', () => setAnimated(false));
      } catch {
        // Static emoji stays.
      }
    })();

    return () => {
      cancelled = true;
      animation?.destroy();
    };
  }, []);

  return (
    <div className="pd-emoji" style={{ width: size, height: size }} aria-hidden>
      <div ref={container} className="pd-emoji__anim" data-ready={animated} />
      {!animated && (
        <span className="pd-emoji__static" style={{ fontSize: Math.round(size * 0.78) }}>
          📰
        </span>
      )}
    </div>
  );
}
