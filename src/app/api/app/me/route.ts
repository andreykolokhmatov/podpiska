import { appHandler } from '@/miniapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = appHandler('me');
