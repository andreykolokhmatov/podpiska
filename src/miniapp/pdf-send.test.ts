import { GrammyError, InputFile } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { cannotMessage, pdfFileName, sendIssuePdf, type PdfSenderDeps } from './pdf-send';

const apiError = (code: number, description: string) =>
  new GrammyError('call failed', { ok: false, error_code: code, description }, 'sendDocument', {});

const input = { telegramUserId: 42, issueId: 'issue-1', number: 7 };

const setup = (send: PdfSenderDeps['sendDocument']) => {
  const render = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const sendDocument = vi.fn(send);
  const lines: string[] = [];
  const deps: PdfSenderDeps = { render, sendDocument, log: (line) => lines.push(line) };
  return { deps, render, sendDocument, lines };
};

describe('cannotMessage', () => {
  it('maps 403 and 400 "chat not found" only', () => {
    expect(cannotMessage(apiError(403, 'Forbidden: bot was blocked by the user'))).toBe(true);
    expect(cannotMessage(apiError(400, 'Bad Request: chat not found'))).toBe(true);
    expect(cannotMessage(apiError(400, 'Bad Request: wrong file identifier'))).toBe(false);
    expect(cannotMessage(apiError(429, 'Too Many Requests'))).toBe(false);
    expect(cannotMessage(new Error('chat not found'))).toBe(false);
  });
});

describe('sendIssuePdf', () => {
  it('renders and uploads on a cache miss, returning the new file_id', async () => {
    const { deps, render, sendDocument } = setup(async () => ({ document: { file_id: 'f1' } }));
    const result = await sendIssuePdf(deps, { ...input, cachedFileId: null });
    expect(result).toEqual({ kind: 'sent', fileId: 'f1' });
    expect(render).toHaveBeenCalledWith('issue-1');
    const [chatId, document, options] = sendDocument.mock.calls[0] ?? [];
    expect(chatId).toBe(42);
    expect(document).toBeInstanceOf(InputFile);
    expect((document as InputFile).filename).toBe(pdfFileName(7));
    expect(options).toEqual({ caption: 'Выпуск № 7' });
  });

  it('re-sends a cached file_id without rendering', async () => {
    const { deps, render, sendDocument } = setup(async () => ({ document: { file_id: 'f1' } }));
    const result = await sendIssuePdf(deps, { ...input, cachedFileId: 'f1' });
    expect(result).toEqual({ kind: 'sent', fileId: 'f1' });
    expect(render).not.toHaveBeenCalled();
    expect(sendDocument.mock.calls[0]?.[1]).toBe('f1');
  });

  it('re-renders once when Telegram rejects the cached file_id', async () => {
    const { deps, render, sendDocument, lines } = setup(async (_chat, document) => {
      if (typeof document === 'string') throw apiError(400, 'Bad Request: wrong file identifier');
      return { document: { file_id: 'f2' } };
    });
    const result = await sendIssuePdf(deps, { ...input, cachedFileId: 'stale' });
    expect(result).toEqual({ kind: 'sent', fileId: 'f2' });
    expect(render).toHaveBeenCalledTimes(1);
    expect(sendDocument).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toContain('cached pdf rejected');
  });

  it('reports cannot_message without rendering when the cached send is refused', async () => {
    const { deps, render } = setup(async () => {
      throw apiError(403, 'Forbidden: bot was blocked by the user');
    });
    expect(await sendIssuePdf(deps, { ...input, cachedFileId: 'f1' })).toEqual({
      kind: 'cannot_message',
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('does not re-render on a non-400 failure', async () => {
    const { deps, render } = setup(async () => {
      throw apiError(429, 'Too Many Requests');
    });
    await expect(sendIssuePdf(deps, { ...input, cachedFileId: 'f1' })).rejects.toBeInstanceOf(
      GrammyError,
    );
    expect(render).not.toHaveBeenCalled();
  });
});
