import { z } from 'zod';

import type {
  Check,
  CheckId,
  SetupAction,
  SetupChecksResponse,
  SetupCronResponse,
  SetupErrorCode,
} from '@/setup/contract';

const CheckSchema = z
  .object({
    // The client only displays the id, so an id newer than this bundle must not fail the parse.
    id: z.custom<CheckId>((value) => typeof value === 'string'),
    status: z.enum(['ok', 'warn', 'fail']),
    title: z.string(),
    hint: z.string().optional(),
  })
  // exactOptionalPropertyTypes: an absent optional field must stay absent, not become `undefined`.
  .transform(({ hint, ...rest }): Check => (hint === undefined ? rest : { ...rest, hint }));

const ChecksResponseSchema = z
  .object({
    checks: z.array(CheckSchema),
    checkedAt: z.string(),
    apply: z
      .discriminatedUnion('ok', [
        z.object({ ok: z.literal(true) }),
        z.object({ ok: z.literal(false), error: z.string() }),
      ])
      .optional(),
  })
  .transform(({ apply, ...rest }): SetupChecksResponse =>
    apply === undefined ? rest : { ...rest, apply },
  );

const CronResponseSchema = z.object({
  url: z.string(),
  method: z.literal('POST'),
  header: z.literal('Authorization'),
  value: z.string(),
}) satisfies z.ZodType<SetupCronResponse>;

const ErrorResponseSchema = z.object({
  error: z.enum([
    'unauthorized',
    'bad_request',
    'rate_limited',
    'not_production',
    'misconfigured',
    'internal',
  ]),
}) satisfies z.ZodType<{ error: SetupErrorCode }>;

/** Server error codes plus the two the client can hit on its own. */
export type SetupFailure = SetupErrorCode | 'network' | 'bad_response';

export type SetupResult<T> = { ok: true; data: T } | { ok: false; error: SetupFailure };

export type SetupFetch = (input: string, init: RequestInit) => Promise<Response>;

async function postSetup<T>(
  fetchImpl: SetupFetch,
  token: string,
  action: SetupAction,
  schema: z.ZodType<T>,
): Promise<SetupResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, action }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    return { ok: false, error: parsed.success ? parsed.data.error : 'bad_response' };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'bad_response' };
}

export function requestChecks(
  fetchImpl: SetupFetch,
  token: string,
  action: 'check' | 'apply',
): Promise<SetupResult<SetupChecksResponse>> {
  return postSetup(fetchImpl, token, action, ChecksResponseSchema);
}

export function requestCron(
  fetchImpl: SetupFetch,
  token: string,
): Promise<SetupResult<SetupCronResponse>> {
  return postSetup(fetchImpl, token, 'cron', CronResponseSchema);
}

export const ERROR_TEXT: Record<SetupFailure, string> = {
  unauthorized: 'Токен не подходит. Скопируйте токен бота этого экземпляра из @BotFather.',
  bad_request: 'Сервер не понял запрос. Проверьте, что токен вставлен целиком, без пробелов.',
  rate_limited: 'Слишком много неверных попыток. Подождите минуту и попробуйте снова.',
  not_production: 'Настройка бота доступна только на production-деплое',
  misconfigured:
    'Экземпляр настроен не до конца: на сервере не хватает переменных окружения. Проверьте Environment Variables в Vercel и сделайте Redeploy.',
  internal: 'Ошибка на сервере. Попробуйте ещё раз через минуту.',
  network: 'Нет связи с сервером. Проверьте интернет и попробуйте снова.',
  bad_response: 'Сервер ответил неожиданно. Обновите страницу и попробуйте снова.',
};

export const STATUS_LABEL: Record<Check['status'], string> = {
  ok: 'Готово',
  warn: 'Внимание',
  fail: 'Ошибка',
};

export const OVERALL_TEXT: Record<Check['status'], string> = {
  ok: 'Всё готово – экземпляр работает.',
  warn: 'Работает, но есть предупреждения.',
  fail: 'Есть ошибки – экземпляр работает не полностью.',
};

export function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
