/** The slice of puppeteer-core the renderer uses; tests inject a fake. */
export interface PdfPage {
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  emulateMediaType(type: 'print'): Promise<void>;
  emulateMediaFeatures(features: { name: string; value: string }[]): Promise<void>;
  goto(
    url: string,
    options: { waitUntil: 'networkidle0'; timeout: number },
  ): Promise<{ status(): number } | null>;
  evaluate(fn: () => Promise<unknown>): Promise<unknown>;
  pdf(options: {
    format: 'A4';
    printBackground: boolean;
    margin: { top: string; right: string; bottom: string; left: string };
  }): Promise<Uint8Array>;
}

export interface PdfBrowser {
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}

export type LaunchBrowser = () => Promise<PdfBrowser>;
export type RenderPdf = (url: string) => Promise<Uint8Array>;

export class PdfRenderError extends Error {
  override readonly name = 'PdfRenderError';
}

/** A4 at 96 dpi: the single-column mobile layout, as the print CSS expects. */
const A4_VIEWPORT = { width: 794, height: 1123 };
const NAVIGATION_TIMEOUT_MS = 30_000;
const MARGIN = '18mm';

/** The page printed for an issue; built from APP_URL only, never from a request's Host. */
export const issuePrintUrl = (appUrl: string, issueId: string): string =>
  `${appUrl}/issue/${issueId}?theme=light`;

export function createPdfRenderer(deps: { launch: LaunchBrowser }): RenderPdf {
  return async (url) => {
    const browser = await deps.launch();
    try {
      const page = await browser.newPage();
      await page.setViewport(A4_VIEWPORT);
      await page.emulateMediaType('print');
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      const response = await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;
      if (status !== 200) throw new PdfRenderError(`issue page answered ${status}`);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      });
    } finally {
      await browser.close();
    }
  };
}
