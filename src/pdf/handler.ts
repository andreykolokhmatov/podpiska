import { z } from 'zod';

import { EnvError, type PdfEnv } from '@/lib/env';
import { pdfFileName, pdfLinkKey, verifyPdfLink } from '@/miniapp/pdf-link';

import { issuePrintUrl, PdfRenderError, type RenderPdf } from './render';

export interface PdfIssueRow {
  status: string;
  number: number | null;
  deletedAt: Date | null;
}

export interface PdfHandlerDeps {
  /** Throws EnvError when TELEGRAM_BOT_TOKEN / APP_URL are invalid (→ 500). */
  env: () => PdfEnv;
  fetchIssue: (id: string) => Promise<PdfIssueRow | undefined>;
  render: RenderPdf;
  now: () => Date;
  /** Metadata only: never the signature or env values. */
  log: (line: string) => void;
}

const uuidSchema = z.uuid();

const text = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });

/**
 * GET /api/issues/<id>/pdf?exp=&sig= — public, but only with a link signed for this issue and
 * still valid. The PDF is cached on the CDN until the link expires (00:00 MSK).
 */
export function createPdfHandler(
  deps: PdfHandlerDeps,
): (req: Request, id: string) => Promise<Response> {
  return async (req, id) => {
    let env: PdfEnv;
    try {
      env = deps.env();
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      // EnvError messages list keys and reasons only, never values.
      deps.log(`[pdf] misconfigured: ${error.message}`);
      return text(500, 'misconfigured');
    }

    if (!uuidSchema.safeParse(id).success) return text(404, 'not found');
    const params = new URL(req.url).searchParams;
    // The CDN keys on the full query: extra params would bypass the cache and re-render each time.
    if ([...params.keys()].some((key) => key !== 'exp' && key !== 'sig')) {
      return text(403, 'forbidden');
    }
    const now = deps.now();
    const check = verifyPdfLink({
      key: pdfLinkKey(env.TELEGRAM_BOT_TOKEN),
      issueId: id,
      exp: params.get('exp'),
      sig: params.get('sig'),
      now,
    });
    if (check !== 'ok') return text(403, check === 'expired' ? 'link expired' : 'forbidden');
    const exp = Number(params.get('exp'));

    const row = await deps.fetchIssue(id);
    if (
      row === undefined ||
      row.status !== 'ready' ||
      row.deletedAt !== null ||
      row.number === null
    ) {
      return text(404, 'not found');
    }

    let pdf: Uint8Array;
    try {
      pdf = await deps.render(issuePrintUrl(env.APP_URL, id));
    } catch (error) {
      const reason =
        error instanceof PdfRenderError
          ? error.message
          : error instanceof Error
            ? error.name
            : 'unknown';
      deps.log(`[pdf] ${id}: render failed: ${reason}`);
      return text(502, 'render failed');
    }
    deps.log(`[pdf] ${id}: rendered ${pdf.byteLength} bytes`);

    const ttl = Math.max(0, exp - Math.floor(now.getTime() / 1000));
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdfFileName(row.number)}"`,
        'Content-Length': String(pdf.byteLength),
        'Access-Control-Allow-Origin': 'https://web.telegram.org',
        'Cache-Control': `public, max-age=0, s-maxage=${ttl}`,
        'X-Robots-Tag': 'noindex',
      },
    });
  };
}
