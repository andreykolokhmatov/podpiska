import { appIdHandler } from '@/miniapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Cold start unpacks Chromium (~5s) before rendering, then the upload to Telegram.
export const maxDuration = 60;

export const POST = appIdHandler('sendPdf');
