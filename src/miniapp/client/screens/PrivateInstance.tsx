'use client';

import { backButton, mainButton } from '@tma.js/sdk-react';
import { Button, Placeholder } from '@telegram-apps/telegram-ui';
import { useEffect } from 'react';

import { openPostLink } from '../sdk';
import { SOURCE_URL, t } from '../texts';

/** Full-screen stop for users not allowed on a private instance: no hub, no MainButton. */
export function PrivateInstance() {
  useEffect(() => {
    mainButton.setParams.ifAvailable({ isVisible: false });
    backButton.hide.ifAvailable();
  }, []);

  return (
    <main className="pd-outside">
      <Placeholder
        header={t.privateInstance.title}
        description={t.privateInstance.text}
        action={
          <Button
            Component="a"
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            size="l"
            stretched
            onClick={(event) => {
              event.preventDefault();
              openPostLink(SOURCE_URL);
            }}
          >
            {t.privateInstance.button}
          </Button>
        }
      >
        <span className="pd-outside__emoji" aria-hidden>
          🔒
        </span>
      </Placeholder>
    </main>
  );
}
