import { getPdfEnv, type PdfEnv } from '@/lib/env';

import { createChromiumLauncher } from './chromium';
import { createPdfRenderer, issuePrintUrl, type RenderPdf } from './render';

let env: PdfEnv | undefined;
let render: RenderPdf | undefined;

const pdfEnv = (): PdfEnv => (env ??= getPdfEnv());

const renderUrl: RenderPdf = (url) => {
  render ??= createPdfRenderer({
    launch: createChromiumLauncher({ executablePath: pdfEnv().CHROME_EXECUTABLE_PATH }),
  });
  return render(url);
};

/** The issue's print page as PDF; throws EnvError when the PDF env is invalid. */
export const renderIssuePdf = (issueId: string): Promise<Uint8Array> =>
  renderUrl(issuePrintUrl(pdfEnv().APP_URL, issueId));

