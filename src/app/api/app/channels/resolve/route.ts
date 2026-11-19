import { appHandler } from '@/miniapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Up to RESOLVE_BATCH_MAX t.me lookups within a ~12s budget (each with a 5s timeout).
export const maxDuration = 30;

export const POST = appHandler('resolveChannels');
