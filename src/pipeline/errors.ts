/** Base for expected pipeline failures; `message` is safe to store in issues.error. */
export class PipelineError extends Error {
  override readonly name: string = 'PipelineError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NoPostsError extends PipelineError {
  override readonly name = 'NoPostsError';
  constructor(message = 'no_posts: no posts with text in the period') {
    super('no_posts', message);
  }
}

export class NoNewsError extends PipelineError {
  override readonly name = 'NoNewsError';
  constructor(message = 'no_news: digests contain no news items') {
    super('no_news', message);
  }
}

export class LeadUnsourcedError extends PipelineError {
  override readonly name = 'LeadUnsourcedError';
  constructor(message = 'lead_unsourced: the lead has no valid source') {
    super('lead_unsourced', message);
  }
}

export class DeadlineError extends PipelineError {
  override readonly name = 'DeadlineError';
  constructor(message = 'timeout: the issue took too long to build') {
    super('timeout', message);
  }
}

export class StatusTransitionError extends PipelineError {
  override readonly name = 'StatusTransitionError';
  constructor(id: string, from: string, to: string) {
    super('bad_transition', `issue ${id} is not in status ${from} (wanted ${to})`);
  }
}

const MAX_MESSAGE = 500;

/** Only the message: never serialise the error (provider errors carry request config). */
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_MESSAGE);
}
