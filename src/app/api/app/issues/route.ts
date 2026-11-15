import { appHandler } from '@/miniapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The build runs in after() within this function's lifetime; the pipeline stops itself at 270s.
export const maxDuration = 300;

export const GET = appHandler('listIssues');
export const POST = appHandler('buildIssue');
