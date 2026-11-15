import { cronHandler } from '@/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Only fans out run requests (10s timeout each, 3 at a time).
export const maxDuration = 60;

export const POST = cronHandler('tick');
