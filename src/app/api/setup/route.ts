import { getSetupHandler } from '@/setup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Checks run in parallel with a 10s timeout each.
export const maxDuration = 30;

export const POST = (req: Request): Promise<Response> => getSetupHandler()(req);
