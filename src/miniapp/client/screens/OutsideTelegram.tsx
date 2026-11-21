'use client';

import { Button, Placeholder } from '@telegram-apps/telegram-ui';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { botUrl, t } from '../texts';

const publicBotSchema = z.object({ username: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/) });

/** The instance's bot username, or null until (or unless) /api/public/bot answers. */
export async function fetchBotUsername(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/api/public/bot');
    if (!res.ok) return null;
    const parsed = publicBotSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.username : null;
  } catch {
    return null;
  }
}

export function OutsideTelegram() {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchBotUsername().then((name) => {
      if (alive) setUsername(name);
    });
    return () => {
      alive = false;
    };
  }, []);

  return <OutsideTelegramView username={username} />;
}

interface OutsideTelegramViewProps {
  /** null: the bot is unknown, so there is no link to offer – only the text. */
  username: string | null;
}

export function OutsideTelegramView({ username }: OutsideTelegramViewProps) {
  return (
    <main className="pd-outside">
      <Placeholder
        header={t.outside.title}
        description={t.outside.text}
        action={
          username === null ? undefined : (
            <Button Component="a" href={botUrl(username)} size="l" stretched>
              {t.outside.button(username)}
            </Button>
          )
        }
      >
        <span className="pd-outside__emoji" aria-hidden>
          📰
        </span>
      </Placeholder>
    </main>
  );
}
