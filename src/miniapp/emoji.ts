import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

import { z } from 'zod';

const gunzipAsync = promisify(gunzip);

/** Decompressed Lottie JSON larger than this is refused (the real 📰 is ~570 KB). */
export const LOTTIE_MAX_BYTES = 1024 * 1024;
// Telegram caps .tgs files at 64 KB.
const TGS_MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

const STICKER_SET = 'AnimatedEmojies';
const NEWSPAPER = '📰';

const lottieSchema = z.looseObject({
  v: z.string(),
  fr: z.number().positive(),
  ip: z.number(),
  op: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  layers: z.array(z.unknown()).min(1),
});

/** Minimal structural check of a Lottie document within the size budget. */
export function validateLottie(text: string): boolean {
  if (new TextEncoder().encode(text).length > LOTTIE_MAX_BYTES) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return lottieSchema.safeParse(value).success;
}

export class EmojiError extends Error {
  override readonly name = 'EmojiError';
}

const botResponse = <T extends z.ZodType>(result: T) => z.object({ ok: z.literal(true), result });

const stickerSetSchema = botResponse(
  z.object({
    stickers: z.array(
      z.looseObject({
        emoji: z.string().optional(),
        is_animated: z.boolean(),
        file_id: z.string(),
      }),
    ),
  }),
);

const fileSchema = botResponse(z.looseObject({ file_path: z.string().min(1) }));

export interface EmojiDeps {
  token: string;
  fetch?: typeof fetch;
}

const stripVariation = (emoji: string): string => emoji.replace(/️/g, '');

/**
 * Telegram's animated 📰 (from the AnimatedEmojies set) as Lottie JSON text. The token is part of
 * every Bot API URL, so errors carry only a step name, never the URL or the response.
 */
export async function fetchNewspaperLottie(deps: EmojiDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const base = 'https://api.telegram.org';
  const call = async (step: string, path: string): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new EmojiError(`${step}: request failed`);
    }
    if (!res.ok) throw new EmojiError(`${step}: HTTP ${res.status}`);
    return res;
  };
  const bot = `/bot${deps.token}`;

  const set = stickerSetSchema.safeParse(
    await (await call('getStickerSet', `${bot}/getStickerSet?name=${STICKER_SET}`)).json(),
  );
  if (!set.success) throw new EmojiError('getStickerSet: unexpected response');
  const sticker = set.data.result.stickers.find(
    (item) => item.is_animated && stripVariation(item.emoji ?? '') === NEWSPAPER,
  );
  if (sticker === undefined) throw new EmojiError('getStickerSet: no animated 📰');

  const file = fileSchema.safeParse(
    await (
      await call('getFile', `${bot}/getFile?file_id=${encodeURIComponent(sticker.file_id)}`)
    ).json(),
  );
  if (!file.success) throw new EmojiError('getFile: unexpected response');

  const res = await call('download', `/file${bot}/${file.data.result.file_path}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > TGS_MAX_BYTES) throw new EmojiError('download: too large');
  const tgs = Buffer.from(await res.arrayBuffer());
  if (tgs.length > TGS_MAX_BYTES) throw new EmojiError('download: too large');

  let text: string;
  try {
    text = (await gunzipAsync(tgs, { maxOutputLength: LOTTIE_MAX_BYTES })).toString('utf8');
  } catch {
    throw new EmojiError('gunzip: not a tgs file or too large');
  }
  if (!validateLottie(text)) throw new EmojiError('validate: not a Lottie document');
  return text;
}

const CACHE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
} as const;

/** GET handler; the Lottie is cached per instance and at the CDN for a day. */
export function createEmojiHandler(
  deps: () => EmojiDeps,
  log: (line: string) => void,
): () => Promise<Response> {
  let cached: Promise<string> | undefined;
  return async () => {
    try {
      cached ??= fetchNewspaperLottie(deps());
      return new Response(await cached, { status: 200, headers: CACHE_HEADERS });
    } catch (error) {
      cached = undefined;
      log(
        `[emoji] unavailable: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`,
      );
      return Response.json(
        { error: 'unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}
