'use client';

import { useState } from 'react';

import { initials } from '../env';
import type { TmaUser } from '../sdk';

interface UserAvatarProps {
  user: TmaUser | null;
  size?: number;
}

export function UserAvatar({ user, size = 40 }: UserAvatarProps) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (user?.photoUrl && !broken) {
    return (
      // A Telegram CDN URL; next/image would proxy it through our server for nothing.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="pd-avatar"
        style={style}
        src={user.photoUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="pd-avatar pd-avatar--initials" style={style} aria-hidden>
      {initials(user?.firstName, user?.lastName)}
    </span>
  );
}
