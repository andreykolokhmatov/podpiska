'use client';

import { Button, Placeholder, Spinner } from '@telegram-apps/telegram-ui';

import type { ClientError } from '../api';
import { errorText, t } from '../texts';

export function Loading() {
  return (
    <div className="pd-center" role="status" aria-label="Загрузка">
      <Spinner size="m" />
    </div>
  );
}

interface LoadErrorProps {
  error: ClientError;
  onRetry: () => void;
}

export function LoadError({ error, onRetry }: LoadErrorProps) {
  const fatal = error.error === 'unauthorized' || error.error === 'expired';
  return (
    <div className="pd-center">
      <Placeholder
        header={t.loadFailed}
        description={errorText(error.error, error.limit)}
        action={
          fatal ? undefined : (
            <Button size="m" mode="bezeled" onClick={onRetry}>
              {t.retry}
            </Button>
          )
        }
      />
    </div>
  );
}
