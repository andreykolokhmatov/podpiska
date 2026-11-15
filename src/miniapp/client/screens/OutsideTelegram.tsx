'use client';

import { Button, Placeholder } from '@telegram-apps/telegram-ui';

import { BOT_URL, t } from '../texts';

export function OutsideTelegram() {
  return (
    <main className="pd-outside">
      <Placeholder
        header={t.outside.title}
        description={t.outside.text}
        action={
          <Button Component="a" href={BOT_URL} size="l" stretched>
            {t.outside.button}
          </Button>
        }
      >
        <span className="pd-outside__emoji" aria-hidden>
          📰
        </span>
      </Placeholder>
    </main>
  );
}
