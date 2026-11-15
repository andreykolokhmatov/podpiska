import { eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { issues } from '@/db/schema';
import { getPdfEnv, type PdfEnv } from '@/lib/env';

import { createChromiumLauncher } from './chromium';
import { createPdfHandler, type PdfHandlerDeps } from './handler';
import { createPdfRenderer, type RenderPdf } from './render';

let env: PdfEnv | undefined;
let render: RenderPdf | undefined;

const pdfEnv = (): PdfEnv => (env ??= getPdfEnv());

const fetchIssue: PdfHandlerDeps['fetchIssue'] = async (id) => {
  const [row] = await getDb()
    .select({ status: issues.status, number: issues.number, deletedAt: issues.deletedAt })
    .from(issues)
    .where(eq(issues.id, id))
    .limit(1);
  return row;
};

/** Wired per request lazily, so `next build` needs no secrets. */
export const handlePdf = createPdfHandler({
  env: pdfEnv,
  fetchIssue,
  render: (url) => {
    render ??= createPdfRenderer({
      launch: createChromiumLauncher({ executablePath: pdfEnv().CHROME_EXECUTABLE_PATH }),
    });
    return render(url);
  },
  now: () => new Date(),
  log: (line) => console.log(line),
});
