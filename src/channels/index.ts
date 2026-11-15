import { WebPreviewSource } from '@/collector';

export * from './add';
export * from './store';

/** For interactive adds (bot, Mini App): fail fast instead of making the user wait. */
export const createInteractiveSource = (): WebPreviewSource =>
  new WebPreviewSource({ timeoutMs: 5000, retries: 0 });
