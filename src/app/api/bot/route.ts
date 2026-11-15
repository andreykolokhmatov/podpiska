import { handleWebhook } from '@/bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export function POST(req: Request): Promise<Response> {
  return handleWebhook(req);
}
