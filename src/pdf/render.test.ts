import { describe, expect, it, vi } from 'vitest';

import {
  createPdfRenderer,
  issuePrintUrl,
  PdfRenderError,
  type PdfBrowser,
  type PdfPage,
} from './render';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const fakeBrowser = (status: number | null, options: { pdfError?: Error } = {}) => {
  const page = {
    setViewport: vi.fn(async () => {}),
    emulateMediaType: vi.fn(async () => {}),
    emulateMediaFeatures: vi.fn(async () => {}),
    goto: vi.fn(async () => (status === null ? null : { status: () => status })),
    evaluate: vi.fn(async () => undefined),
    pdf: vi.fn(async () => {
      if (options.pdfError !== undefined) throw options.pdfError;
      return PDF;
    }),
  } satisfies PdfPage;
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  } satisfies PdfBrowser;
  return { browser, page, launch: vi.fn(async () => browser) };
};

const URL_ = issuePrintUrl('https://podpiska.example', '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e');

describe('createPdfRenderer', () => {
  it('prints the light issue page as A4 and closes the browser', async () => {
    const { browser, page, launch } = fakeBrowser(200);
    const pdf = await createPdfRenderer({ launch })(URL_);

    expect(pdf).toBe(PDF);
    expect(URL_).toBe(
      'https://podpiska.example/issue/0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e?theme=light',
    );
    expect(page.setViewport).toHaveBeenCalledWith({ width: 794, height: 1123 });
    expect(page.emulateMediaType).toHaveBeenCalledWith('print');
    expect(page.emulateMediaFeatures).toHaveBeenCalledWith([
      { name: 'prefers-color-scheme', value: 'light' },
    ]);
    expect(page.goto).toHaveBeenCalledWith(URL_, { waitUntil: 'networkidle0', timeout: 30_000 });
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(page.pdf).toHaveBeenCalledWith({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '18mm', bottom: '18mm', left: '18mm' },
    });
    expect(page.evaluate.mock.invocationCallOrder[0]).toBeLessThan(
      page.pdf.mock.invocationCallOrder[0] ?? 0,
    );
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it.each([404, 500, null])(
    'throws on a %s answer and still closes the browser',
    async (status) => {
      const { browser, page, launch } = fakeBrowser(status);
      await expect(createPdfRenderer({ launch })(URL_)).rejects.toBeInstanceOf(PdfRenderError);
      expect(page.pdf).not.toHaveBeenCalled();
      expect(browser.close).toHaveBeenCalledOnce();
    },
  );

  it('closes the browser when printing fails', async () => {
    const { browser, launch } = fakeBrowser(200, { pdfError: new Error('Target closed') });
    await expect(createPdfRenderer({ launch })(URL_)).rejects.toThrow('Target closed');
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
