import { appIdHandler } from '@/miniapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = appIdHandler('getIssue');
export const DELETE = appIdHandler('deleteIssue');
