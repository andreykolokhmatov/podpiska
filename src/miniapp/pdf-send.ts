import { GrammyError, InputFile } from 'grammy';

export const pdfFileName = (number: number): string => `Podpiska-${number}.pdf`;

/** Bot API answers for a user the bot may not write to: blocked (403) or never started (400). */
export const cannotMessage = (error: unknown): boolean =>
  error instanceof GrammyError &&
  (error.error_code === 403 ||
    (error.error_code === 400 && /chat not found/i.test(error.description)));

export interface PdfSenderDeps {
  /** Renders the issue's print page; throws EnvError when the PDF env is invalid. */
  render: (issueId: string) => Promise<Uint8Array>;
  /** sendDocument of the bot that signed the initData. */
  sendDocument: (
    chatId: number,
    document: string | InputFile,
    options: { caption: string },
  ) => Promise<{ document?: { file_id: string } }>;
  log: (line: string) => void;
}

export interface PdfSendInput {
  telegramUserId: number;
  issueId: string;
  number: number;
  /** file_id of an earlier upload by the same bot; null renders and uploads. */
  cachedFileId: string | null;
}

export type PdfSendResult =
  /** fileId of the sent document, to cache (null if Telegram did not return one). */
  | { kind: 'sent'; fileId: string | null }
  | { kind: 'cannot_message' };

/** Re-sends a cached upload when there is one; renders (Chromium) only on a miss or a rejection. */
export async function sendIssuePdf(
  deps: PdfSenderDeps,
  input: PdfSendInput,
): Promise<PdfSendResult> {
  const caption = `Выпуск №\u00A0${input.number}`;
  const send = async (document: string | InputFile): Promise<PdfSendResult> => {
    try {
      const message = await deps.sendDocument(input.telegramUserId, document, { caption });
      return { kind: 'sent', fileId: message.document?.file_id ?? null };
    } catch (error) {
      if (cannotMessage(error)) return { kind: 'cannot_message' };
      throw error;
    }
  };

  if (input.cachedFileId !== null) {
    try {
      return await send(input.cachedFileId);
    } catch (error) {
      // A stale or foreign file_id is a 400; anything else is not fixed by re-rendering.
      if (!(error instanceof GrammyError && error.error_code === 400)) throw error;
      deps.log(`[app] issue ${input.issueId}: cached pdf rejected, re-rendering`);
    }
  }
  const pdf = await deps.render(input.issueId);
  return send(new InputFile(pdf, pdfFileName(input.number)));
}
