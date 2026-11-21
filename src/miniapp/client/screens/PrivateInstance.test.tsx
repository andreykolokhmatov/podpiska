import { AppRoot } from '@telegram-apps/telegram-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiFetch, configureApi } from '../api';
import { privateInstanceStore } from '../privateInstance';
import { SOURCE_URL } from '../texts';
import { PrivateInstance } from './PrivateInstance';

describe('private instance', () => {
  it('a 403 private_instance from any app call closes the app', async () => {
    const calls: string[] = [];
    configureApi({
      initDataRaw: 'init',
      fetch: (path) => {
        calls.push(path);
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'private_instance' }), { status: 403 }),
        );
      },
    });
    expect(privateInstanceStore.get()).toBe(false);

    const res = await apiFetch('/api/app/me', z.object({}));

    expect(calls).toEqual(['/api/app/me']);
    expect(res).toMatchObject({ ok: false, status: 403, error: { error: 'private_instance' } });
    expect(privateInstanceStore.get()).toBe(true);
  });

  it('renders the stop screen with a link to the source', () => {
    const html = renderToStaticMarkup(
      <AppRoot>
        <PrivateInstance />
      </AppRoot>,
    );
    expect(html).toContain('Это частный экземпляр');
    expect(html).toContain('Подпиской на этом боте пользуется только его владелец.');
    expect(html).toContain(`href="${SOURCE_URL}"`);
    expect(html).toContain('Как поднять свою');
  });
});
