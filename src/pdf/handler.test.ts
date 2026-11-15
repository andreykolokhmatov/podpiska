import { describe, expect, it, vi } from 'vitest';

import { EnvError, type PdfEnv } from '@/lib/env';
import { buildPdfLink, pdfLinkKey } from '@/miniapp/pdf-link';

import { createPdfHandler, type PdfHandlerDeps, type PdfIssueRow } from './handler';
import { PdfRenderError } from './render';

const ID = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e';
const env: PdfEnv = {
  TELEGRAM_BOT_TOKEN: '111111:prod-token',
  APP_URL: 'https://podpiska.example',
  CHROME_EXECUTABLE_PATH: undefined,
};
// 12:00 MSK; the link expires at 00:00 MSK, 12h later.
const now = new Date('2026-11-15T09:00:00Z');
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const ready: PdfIssueRow = { status: 'ready', number: 7, deletedAt: null };

const setup = (
  opts: { row?: PdfIssueRow | undefined; render?: PdfHandlerDeps['render']; at?: Date } = {},
) => {
  const render = vi.fn<PdfHandlerDeps['render']>(opts.render ?? (async () => PDF));
  const fetchIssue = vi.fn(async () => ('row' in opts ? opts.row : ready));
  const lines: string[] = [];
  const handler = createPdfHandler({
    env: () => env,
    fetchIssue,
    render,
    now: () => opts.at ?? now,
    log: (line) => lines.push(line),
  });
  return { handler, render, fetchIssue, lines };
};

const signedUrl = (issueId = ID, at = now) =>
  buildPdfLink({
    appUrl: 'https://anything.example',
    key: pdfLinkKey(env.TELEGRAM_BOT_TOKEN),
    issueId,
    number: 7,
    now: at,
  }).url;

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe('GET /api/issues/<id>/pdf', () => {
  it('renders a signed link with download and cache headers', async () => {
    const { handler, render } = setup();
    const res = await handler(get(signedUrl()), ID);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Podpiska-7.pdf"');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://web.telegram.org');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=43200');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(render).toHaveBeenCalledWith(`https://podpiska.example/issue/${ID}?theme=light`);
  });

  it('renders from APP_URL even when the Host header is spoofed', async () => {
    const { handler, render } = setup();
    const url = signedUrl().replace('https://anything.example', 'https://evil.example');
    await handler(get(url, { host: 'evil.example', 'x-forwarded-host': 'evil.example' }), ID);
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]?.[0].startsWith('https://podpiska.example/')).toBe(true);
  });

  it('answers 403 for a bad, foreign, missing or expired signature without touching the DB', async () => {
    const { handler, render, fetchIssue } = setup();
    const other = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5f';
    const urls = [
      signedUrl(other),
      `${signedUrl()}&x=1`,
      signedUrl().replace(/sig=[^&]+/, 'sig=AAAA'),
      `https://podpiska.example/api/issues/${ID}/pdf`,
    ];
    for (const url of urls) {
      expect((await handler(get(url), ID)).status).toBe(403);
    }
    const expired = setup({ at: new Date('2026-11-15T21:00:00Z') });
    const res = await expired.handler(get(signedUrl()), ID);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('link expired');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it.each<[string, PdfIssueRow | undefined]>([
    ['missing', undefined],
    ['deleted', { ...ready, deletedAt: now }],
    ['building', { status: 'composing', number: null, deletedAt: null }],
    ['failed', { status: 'failed', number: null, deletedAt: null }],
  ])('answers 404 for a %s issue and never renders', async (_, row) => {
    const { handler, render } = setup({ row });
    const res = await handler(get(signedUrl()), ID);
    expect(res.status).toBe(404);
    expect(render).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed id', async () => {
    const { handler, fetchIssue } = setup();
    expect((await handler(get(signedUrl()), '../me')).status).toBe(404);
    expect(fetchIssue).not.toHaveBeenCalled();
  });

  it('answers 502 when rendering fails and logs no secrets', async () => {
    const { handler, lines } = setup({
      render: async () => {
        throw new PdfRenderError('issue page answered 404');
      },
    });
    const res = await handler(get(signedUrl()), ID);
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(lines).toEqual([`[pdf] ${ID}: render failed: issue page answered 404`]);
  });

  it('answers 500 misconfigured on a bad env', async () => {
    const lines: string[] = [];
    const handler = createPdfHandler({
      env: () => {
        throw new EnvError('Invalid environment variables:\n  - APP_URL: is required');
      },
      fetchIssue: vi.fn(),
      render: vi.fn(),
      now: () => now,
      log: (line) => lines.push(line),
    });
    expect((await handler(get(signedUrl()), ID)).status).toBe(500);
    expect(lines[0]).toContain('APP_URL');
  });
});
