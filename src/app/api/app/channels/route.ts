import { appHandler } from '@/miniapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Adding an unknown channel scrapes t.me once (5s timeout).
export const maxDuration = 30;

export const GET = appHandler('listChannels');
export const POST = appHandler('addChannel');
export const DELETE = appHandler('removeChannel');
