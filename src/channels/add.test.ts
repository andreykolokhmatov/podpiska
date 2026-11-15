import { describe, expect, it, vi } from 'vitest';

import {
  ChannelUnavailableError,
  CollectorHttpError,
  CollectorParseError,
  InvalidChannelError,
  RateLimitedError,
  type ChannelInfo,
} from '@/collector';

import { AddChannelError, addUserChannel, type ChannelsStore, type LinkStatus } from './add';

const info: ChannelInfo = {
  username: 'toporlive',
  displayUsername: 'toporlive',
  title: 'Топор Live',
  avatarUrl: null,
};

const setup = (opts: { known?: ChannelInfo; link?: LinkStatus; fetch?: () => unknown } = {}) => {
  const store = {
    findAvailableChannel: vi.fn<ChannelsStore['findAvailableChannel']>(async () => opts.known),
    linkUserChannel: vi.fn<ChannelsStore['linkUserChannel']>(async () => opts.link ?? 'added'),
  };
  const fetchChannelInfo = vi.fn(async (): Promise<ChannelInfo> => {
    const outcome = opts.fetch?.() ?? info;
    if (outcome instanceof Error) throw outcome;
    return outcome as ChannelInfo;
  });
  return { deps: { store, source: { fetchChannelInfo } }, store, fetchChannelInfo };
};

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof AddChannelError)) throw new Error('expected AddChannelError');
  return error.reason;
};

describe('addUserChannel', () => {
  it('skips the scrape for a known available channel', async () => {
    const { deps, fetchChannelInfo, store } = setup({ known: info, link: 'exists' });
    await expect(addUserChannel(deps, 1, 'toporlive', 50)).resolves.toEqual({
      status: 'exists',
      channel: info,
    });
    expect(fetchChannelInfo).not.toHaveBeenCalled();
    expect(store.linkUserChannel).toHaveBeenCalledWith(1, info, 50);
  });

  it('scrapes an unknown channel and links it', async () => {
    const { deps, fetchChannelInfo } = setup();
    const result = await addUserChannel(deps, 1, 'toporlive', 50);
    expect(result.status).toBe('added');
    expect(fetchChannelInfo).toHaveBeenCalledWith('toporlive');
  });

  it('passes the limit result through', async () => {
    const { deps } = setup({ link: 'limit' });
    expect((await addUserChannel(deps, 1, 'toporlive', 3)).status).toBe('limit');
  });

  it.each([
    [new RateLimitedError('slow down'), 'retry_later'],
    [new CollectorHttpError(null, 'timeout'), 'retry_later'],
    [new CollectorHttpError(503, '503'), 'retry_later'],
    [new CollectorHttpError(404, '404'), 'not_found'],
    [new ChannelUnavailableError('not_found_or_preview_disabled', 'gone'), 'not_found'],
    [new CollectorParseError('no channel header'), 'not_found'],
    [new InvalidChannelError('private_link', 'private'), 'private'],
  ])('maps %s to %s without linking', async (error, reason) => {
    const { deps, store } = setup({ fetch: () => error });
    expect(await reasonOf(addUserChannel(deps, 1, 'toporlive', 50))).toBe(reason);
    expect(store.linkUserChannel).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors', async () => {
    const { deps } = setup({ fetch: () => new TypeError('boom') });
    await expect(addUserChannel(deps, 1, 'toporlive', 50)).rejects.toBeInstanceOf(TypeError);
  });
});
