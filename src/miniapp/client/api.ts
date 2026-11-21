import type { z } from 'zod';

import { apiErrorSchema, AUTH_SCHEME, type ApiError } from '@/miniapp/contract';

import { privateInstanceStore } from './privateInstance';
import type { ClientErrorCode } from './texts';

export type ClientError = Omit<ApiError, 'error'> & { error: ClientErrorCode };

export type ApiResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: ClientError };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let rawInitData: string | undefined;
let transport: FetchLike | undefined;

/** Set once by initTmaOnce; the dev mock swaps the transport for fixtures. */
export function configureApi(options: { initDataRaw: string | undefined; fetch?: FetchLike }) {
  rawInitData = options.initDataRaw;
  transport = options.fetch;
}

interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  { method = 'GET', body, signal }: ApiInit = {},
): Promise<ApiResult<T>> {
  if (!rawInitData) return { ok: false, status: 401, error: { error: 'unauthorized' } };
  const headers: Record<string, string> = { Authorization: `${AUTH_SCHEME} ${rawInitData}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await (transport ?? fetch)(path, {
      method,
      headers,
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, error: { error: 'network' } };
  }

  const json: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, status: res.status, data: parsed.data }
      : { ok: false, status: res.status, error: { error: 'internal' } };
  }
  const parsed = apiErrorSchema.safeParse(json);
  if (parsed.success && parsed.data.error === 'private_instance') privateInstanceStore.mark();
  return {
    ok: false,
    status: res.status,
    error: parsed.success ? parsed.data : { error: 'internal' },
  };
}
