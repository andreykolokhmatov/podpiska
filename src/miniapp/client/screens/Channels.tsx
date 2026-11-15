'use client';

import { Avatar, Cell, IconButton, Input, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  addChannelResponseSchema,
  CHANNEL_INPUT_MAX,
  channelsResponseSchema,
  removeChannelResponseSchema,
  type ChannelView,
} from '@/miniapp/contract';

import { apiFetch } from '../api';
import { initials } from '../env';
import { useBackButton, useGoBack, useMainButton } from '../hooks';
import { confirmDestructive, haptic } from '../sdk';
import { errorText, t } from '../texts';
import { useApi } from '../useApi';
import { LoadError, Loading } from './LoadState';

const label = (channel: ChannelView) => channel.title?.trim() || `@${channel.username}`;

type Message = { kind: 'error' | 'success'; text: string } | null;

export function Channels() {
  const goBack = useGoBack();
  const { resource, reload, setData } = useApi(() =>
    apiFetch('/api/app/channels', channelsResponseSchema),
  );
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('add') === '1') inputRef.current?.focus();
  }, []);

  const add = async () => {
    const value = input.trim();
    if (value === '' || adding) return;
    haptic.impact();
    setAdding(true);
    setMessage(null);
    const res = await apiFetch('/api/app/channels', addChannelResponseSchema, {
      method: 'POST',
      body: { input: value },
    });
    setAdding(false);
    if (!res.ok) {
      haptic.error();
      setMessage({ kind: 'error', text: errorText(res.error.error, res.error.limit) });
      return;
    }
    haptic.success();
    const { channel, status } = res.data;
    setInput('');
    setMessage({
      kind: 'success',
      text:
        status === 'added' ? t.channels.added(label(channel)) : t.channels.exists(label(channel)),
    });
    setData((data) => ({
      ...data,
      channels: [channel, ...data.channels.filter((c) => c.username !== channel.username)],
    }));
  };

  const remove = async (channel: ChannelView) => {
    haptic.selection();
    const ok = await confirmDestructive(
      t.channels.confirmTitle,
      t.channels.confirmText(label(channel)),
      t.channels.remove,
    );
    if (!ok) return;
    const res = await apiFetch('/api/app/channels', removeChannelResponseSchema, {
      method: 'DELETE',
      body: { username: channel.username },
    });
    if (!res.ok && res.error.error !== 'not_found') {
      haptic.error();
      setMessage({ kind: 'error', text: errorText(res.error.error) });
      return;
    }
    haptic.success();
    setData((data) => ({
      ...data,
      channels: data.channels.filter((c) => c.username !== channel.username),
    }));
  };

  useBackButton(goBack);
  // Shown only while there is something to add: a disabled MainButton looks the same as an
  // enabled one in Telegram, and readers tapped it to "finish" instead of going back.
  useMainButton(
    input.trim() !== '' || adding
      ? { text: t.channels.add, enabled: !adding, loader: adding, shine: false }
      : null,
    () => void add(),
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void add();
  };

  return (
    <main className="pd-page">
      <form onSubmit={onSubmit}>
        <Section
          className="pd-form-section"
          header={t.channels.addHeader}
          footer={
            <p
              className={`pd-section-note${message ? ` pd-section-note--${message.kind}` : ''}`}
              role={message?.kind === 'error' ? 'alert' : undefined}
            >
              {message?.text ?? t.channels.addFooter}
            </p>
          }
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.channels.placeholder}
            aria-label={t.channels.addHeader}
            status={message?.kind === 'error' ? 'error' : 'default'}
            maxLength={CHANNEL_INPUT_MAX}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={adding}
          />
        </Section>
      </form>

      {resource.status === 'loading' && <Loading />}
      {resource.status === 'error' && <LoadError error={resource.error} onRetry={reload} />}
      {resource.status === 'ok' &&
        (resource.data.channels.length === 0 ? (
          <Placeholder header={t.channels.emptyTitle} description={t.channels.emptyText} />
        ) : (
          <Section
            header={t.channels.listHeader(resource.data.channels.length, resource.data.limit)}
          >
            {resource.data.channels.map((channel) => (
              <Cell
                key={channel.username}
                Component="div"
                before={
                  <Avatar
                    size={40}
                    src={channel.avatarUrl ?? undefined}
                    referrerPolicy="no-referrer"
                    acronym={initials(channel.title ?? channel.username)}
                  />
                }
                subtitle={
                  channel.available ? (
                    `@${channel.username}`
                  ) : (
                    <span className="pd-warn">
                      @{channel.username} · {t.channels.unavailable}
                    </span>
                  )
                }
                after={
                  <IconButton
                    mode="plain"
                    size="s"
                    className="pd-danger"
                    aria-label={`${t.channels.remove} ${label(channel)}`}
                    onClick={() => void remove(channel)}
                  >
                    <Trash2 size={20} />
                  </IconButton>
                }
              >
                {label(channel)}
              </Cell>
            ))}
          </Section>
        ))}
    </main>
  );
}
