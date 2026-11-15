import { handlePdf } from '@/pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Cold start unpacks Chromium (~5s) before rendering.
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePdf(req, id);
}
