import { WebPreviewSource } from '@/collector';

export * from './add';
export * from './avatar';
export * from './resolve';
export * from './store';
export * from './tg-export';

/** For interactive adds (bot, Mini App): fail fast instead of making the user wait. */
export const createInteractiveSource = (): WebPreviewSource =>
  new WebPreviewSource({ timeoutMs: 5000, retries: 0 });
