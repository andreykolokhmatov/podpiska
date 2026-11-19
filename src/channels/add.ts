import {
  ChannelUnavailableError,
  CollectorHttpError,
  CollectorParseError,
  InvalidChannelError,
  RateLimitedError,
  type ChannelInfo,
  type PostSource,
} from '@/collector';

export type LinkStatus = 'added' | 'exists' | 'limit';

/** Outcome of linking one username in a bulk commit. */
export type BulkLinkStatus = LinkStatus | 'not_found';

export interface BulkLinkResult {
  username: string;
  status: BulkLinkStatus;
}

export interface AddChannelResult {
  status: LinkStatus;
  channel: ChannelInfo;
}

export interface ChannelsStore {
  /** A known channel whose last scrape succeeded, if any. */
  findAvailableChannel(username: string): Promise<ChannelInfo | undefined>;
  /**
   * In one transaction with the user row locked: an existing link → 'exists', at the limit →
   * 'limit' (nothing written), otherwise upserts the channel and links it → 'added'.
   */
  linkUserChannel(userId: number, channel: ChannelInfo, limit: number | null): Promise<LinkStatus>;
  /** Known available channels among `usernames` (no scrape). */
  findAvailableChannels(usernames: readonly string[]): Promise<ChannelInfo[]>;
  /** Which of `usernames` the user is already subscribed to. */
  listLinkedUsernames(userId: number, usernames: readonly string[]): Promise<string[]>;
  /** Stores a freshly scraped channel as available (a cache for later adds). */
  upsertChannel(channel: ChannelInfo): Promise<void>;
  /**
   * One transaction with the user row locked: links, in input order, the usernames known as
   * available until the limit (null = none) is reached. Unknown/unavailable → not_found,
   * linked → exists, over the limit → limit. One result per unique username, input order.
   */
  linkUserChannels(
    userId: number,
    usernames: readonly string[],
    limit: number | null,
  ): Promise<BulkLinkResult[]>;
}

export type AddChannelFailure = 'private' | 'not_found' | 'invalid' | 'retry_later';

export class AddChannelError extends Error {
  override readonly name = 'AddChannelError';

  constructor(
    readonly reason: AddChannelFailure,
    options?: ErrorOptions,
  ) {
    super(`cannot add channel: ${reason}`, options);
  }
}

export function toAddChannelError(error: unknown): AddChannelError | undefined {
  if (error instanceof InvalidChannelError) {
    return new AddChannelError(error.reason === 'invalid' ? 'invalid' : 'private', {
      cause: error,
    });
  }
  // A page that does not parse as a channel preview is, for the user, a missing channel.
  if (error instanceof ChannelUnavailableError || error instanceof CollectorParseError) {
    return new AddChannelError('not_found', { cause: error });
  }
  if (error instanceof RateLimitedError) {
    return new AddChannelError('retry_later', { cause: error });
  }
  if (error instanceof CollectorHttpError) {
    // null = network error or timeout.
    const transient = error.status === null || error.status === 429 || error.status >= 500;
    return new AddChannelError(transient ? 'retry_later' : 'not_found', { cause: error });
  }
  return undefined;
}

export interface AddChannelDeps {
  store: Pick<ChannelsStore, 'findAvailableChannel' | 'linkUserChannel'>;
  source: Pick<PostSource, 'fetchChannelInfo'>;
}

/**
 * Subscribes a user to a public channel (shared by the bot and the Mini App API).
 * `username` must already be normalized. Throws AddChannelError for user-facing failures.
 */
export async function addUserChannel(
  deps: AddChannelDeps,
  userId: number,
  username: string,
  /** null = no limit (the owner). */
  limit: number | null,
): Promise<AddChannelResult> {
  let channel = await deps.store.findAvailableChannel(username);
  if (channel === undefined) {
    try {
      channel = await deps.source.fetchChannelInfo(username);
    } catch (error) {
      throw toAddChannelError(error) ?? error;
    }
  }
  const status = await deps.store.linkUserChannel(userId, channel, limit);
  return { status, channel };
}
