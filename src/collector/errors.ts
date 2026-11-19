export type CollectorErrorCode =
  | 'InvalidChannel'
  | 'ChannelUnavailable'
  | 'RateLimited'
  | 'HttpError'
  | 'ParseError'
  | 'DeadlineExceeded';

export class CollectorError extends Error {
  override readonly name: string = 'CollectorError';

  constructor(
    readonly code: CollectorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type InvalidChannelReason = 'invite_link' | 'private_link' | 'invalid';

export class InvalidChannelError extends CollectorError {
  override readonly name = 'InvalidChannelError';

  constructor(
    readonly reason: InvalidChannelReason,
    message: string,
  ) {
    super('InvalidChannel', `${message} (${reason})`);
  }
}

export type ChannelUnavailableReason = 'not_found_or_preview_disabled' | 'not_channel';

export class ChannelUnavailableError extends CollectorError {
  override readonly name = 'ChannelUnavailableError';

  constructor(
    readonly reason: ChannelUnavailableReason,
    message: string,
  ) {
    super('ChannelUnavailable', `${message} (${reason})`);
  }
}

export class RateLimitedError extends CollectorError {
  override readonly name = 'RateLimitedError';

  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super('RateLimited', message);
  }
}

export class CollectorHttpError extends CollectorError {
  override readonly name = 'CollectorHttpError';

  constructor(
    readonly status: number | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super('HttpError', message, options);
  }
}

export class CollectorParseError extends CollectorError {
  override readonly name = 'CollectorParseError';

  constructor(message: string) {
    super('ParseError', message);
  }
}

/** The caller's deadline passed before the request could start; nothing was sent. */
export class DeadlineExceededError extends CollectorError {
  override readonly name = 'DeadlineExceededError';

  constructor(message: string) {
    super('DeadlineExceeded', message);
  }
}
