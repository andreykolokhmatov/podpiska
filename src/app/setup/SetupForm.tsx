'use client';

import { useId, useRef, useState, type FormEvent } from 'react';

import {
  overallStatus,
  type Check,
  type SetupChecksResponse,
  type SetupCronResponse,
} from '@/setup/contract';
import {
  ERROR_TEXT,
  OVERALL_TEXT,
  STATUS_LABEL,
  formatCheckedAt,
  requestChecks,
  requestCron,
  type SetupFailure,
  type SetupFetch,
} from './setup-client';

type Pending = 'check' | 'apply' | 'cron' | null;

export interface SetupState {
  pending: Pending;
  result: SetupChecksResponse | null;
  error: SetupFailure | null;
  cron: SetupCronResponse | null;
  cronError: SetupFailure | null;
}

export const INITIAL_STATE: SetupState = {
  pending: null,
  result: null,
  error: null,
  cron: null,
  cronError: null,
};

interface SetupFormProps {
  fetchImpl?: SetupFetch;
}

export function SetupForm({ fetchImpl = (input, init) => fetch(input, init) }: SetupFormProps) {
  // The token lives only in this state: never in storage, the URL or a cookie.
  const [token, setToken] = useState('');
  const [state, setState] = useState<SetupState>(INITIAL_STATE);

  async function runChecks(action: 'check' | 'apply') {
    setState((s) => ({ ...s, pending: action, error: null }));
    const res = await requestChecks(fetchImpl, token.trim(), action);
    setState((s) =>
      res.ok
        ? { ...s, pending: null, result: res.data, error: null }
        : // A failed check means the token is not confirmed: drop results that needed it.
          action === 'check'
          ? { ...INITIAL_STATE, error: res.error }
          : { ...s, pending: null, error: res.error },
    );
  }

  async function showCron() {
    setState((s) => ({ ...s, pending: 'cron', cronError: null }));
    const res = await requestCron(fetchImpl, token.trim());
    setState((s) =>
      res.ok
        ? { ...s, pending: null, cron: res.data, cronError: null }
        : { ...s, pending: null, cronError: res.error },
    );
  }

  return (
    <SetupFormView
      token={token}
      state={state}
      onTokenChange={setToken}
      onCheck={() => void runChecks('check')}
      onApply={() => void runChecks('apply')}
      onShowCron={() => void showCron()}
    />
  );
}

interface SetupFormViewProps {
  token: string;
  state: SetupState;
  onTokenChange: (token: string) => void;
  onCheck: () => void;
  onApply: () => void;
  onShowCron: () => void;
}

export function SetupFormView({
  token,
  state,
  onTokenChange,
  onCheck,
  onApply,
  onShowCron,
}: SetupFormViewProps) {
  const inputId = useId();
  const busy = state.pending !== null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy && token.trim() !== '') onCheck();
  }

  return (
    <>
      <form className="su-form" onSubmit={submit}>
        <label htmlFor={inputId}>Токен бота</label>
        <input
          id={inputId}
          type="password"
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          placeholder="123456789:AA…"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          required
        />
        <button type="submit" disabled={busy || token.trim() === ''}>
          {state.pending === 'check' ? 'Проверяем…' : 'Проверить'}
        </button>
      </form>

      {state.error !== null && (
        <p className="su-error" role="alert">
          {ERROR_TEXT[state.error]}
        </p>
      )}

      {state.result !== null && (
        <>
          <ChecksPanel result={state.result} />
          <div className="su-actions">
            <button type="button" onClick={onApply} disabled={busy}>
              {state.pending === 'apply' ? 'Настраиваем…' : 'Настроить бота'}
            </button>
            <p className="muted">Webhook, команды и кнопка меню – заново, по текущему адресу.</p>
            <ApplyLine apply={state.result.apply} />
          </div>
          <CronSection
            cron={state.cron}
            error={state.cronError}
            pending={state.pending === 'cron'}
            busy={busy}
            onShow={onShowCron}
          />
        </>
      )}
    </>
  );
}

const MARK: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✕' };

function ChecksPanel({ result }: { result: SetupChecksResponse }) {
  const overall = overallStatus(result.checks);
  const time = formatCheckedAt(result.checkedAt);
  return (
    <section className="su-result" aria-labelledby="su-result-title">
      <h2 id="su-result-title" className="vh">
        Результат проверки
      </h2>
      <p className={`su-overall su-${overall}`} role="status">
        <Marker status={overall} />
        {OVERALL_TEXT[overall]}
      </p>
      <ul className="su-checks">
        {result.checks.map((check) => (
          <li key={check.id} className={`su-${check.status}`}>
            <Marker status={check.status} />
            <div>
              <div className="su-title">{check.title}</div>
              {check.hint !== undefined && <div className="su-hint">{check.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
      {time !== '' && <p className="muted">Проверено в {time}</p>}
    </section>
  );
}

function Marker({ status }: { status: Check['status'] }) {
  return (
    <>
      <span className="su-mark" aria-hidden="true">
        {MARK[status]}
      </span>
      <span className="vh">{STATUS_LABEL[status]}: </span>
    </>
  );
}

function ApplyLine({ apply }: { apply: SetupChecksResponse['apply'] }) {
  if (apply === undefined) return null;
  if (apply.ok) {
    return (
      <p className="su-ok-text" role="status">
        Бот настроен.
      </p>
    );
  }
  return (
    <p className="su-error" role="alert">
      Не удалось настроить бота: {apply.error}
    </p>
  );
}

interface CronSectionProps {
  cron: SetupCronResponse | null;
  error: SetupFailure | null;
  pending: boolean;
  busy: boolean;
  onShow: () => void;
}

export function CronSection({ cron, error, pending, busy, onShow }: CronSectionProps) {
  return (
    <section className="su-cron" aria-labelledby="su-cron-title">
      <h2 id="su-cron-title">Расписание (cron-job.org)</h2>
      <p>
        Выпуски по расписанию запускает внешний будильник: раз в час он стучится в этот экземпляр.
        Бесплатного cron-job.org для этого достаточно.
      </p>
      {cron === null ? (
        <button type="button" onClick={onShow} disabled={busy}>
          {pending ? 'Загружаем…' : 'Показать настройки'}
        </button>
      ) : (
        <CronSettings cron={cron} />
      )}
      {error !== null && (
        <p className="su-error" role="alert">
          {ERROR_TEXT[error]}
        </p>
      )}
    </section>
  );
}

export function CronSettings({
  cron,
  initialRevealed = false,
}: {
  cron: SetupCronResponse;
  initialRevealed?: boolean;
}) {
  const [revealed, setRevealed] = useState(initialRevealed);
  return (
    <>
      <div className="su-fields">
        <CopyField label="URL" value={cron.url} />
        <CopyField label="Метод" value={cron.method} />
        <CopyField label="Заголовок" value={cron.header} />
        <CopyField
          label="Значение"
          value={cron.value}
          masked={!revealed}
          onToggle={() => setRevealed((r) => !r)}
        />
      </div>
      <ol className="su-steps">
        <li>
          Войдите на cron-job.org и нажмите <b>Create cronjob</b>.
        </li>
        <li>
          В поле <b>URL</b> вставьте адрес выше.
        </li>
        <li>
          Расписание – <b>Every hour</b> (каждый час) на 1-й минуте.
        </li>
        <li>
          Откройте вкладку <b>Advanced</b> и выберите <b>Request method: POST</b>.
        </li>
        <li>
          В <b>Headers</b> добавьте заголовок <b>Authorization</b> со значением из поля «Значение».
        </li>
        <li>
          Сохраните и нажмите <b>Test run</b> – в ответе должно быть <b>200</b>.
        </li>
      </ol>
    </>
  );
}

interface CopyFieldProps {
  label: string;
  value: string;
  masked?: boolean;
  onToggle?: () => void;
}

function CopyField({ label, value, masked = false, onToggle }: CopyFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null);

  function flash(next: 'copied' | 'selected') {
    setCopied(next);
    setTimeout(() => setCopied(null), 2000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      flash('copied');
    } catch {
      // No clipboard API (insecure context, old Safari): leave the text selected for a manual copy.
      if (masked) onToggle?.();
      requestAnimationFrame(() => inputRef.current?.select());
      flash('selected');
    }
  }

  return (
    <div className="su-field">
      <label htmlFor={id}>{label}</label>
      <div className="su-row">
        <input
          id={id}
          ref={inputRef}
          type={masked ? 'password' : 'text'}
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        {onToggle !== undefined && (
          <button type="button" className="su-small" onClick={onToggle} aria-pressed={!masked}>
            {masked ? 'Показать' : 'Скрыть'}
          </button>
        )}
        <button type="button" className="su-small" onClick={() => void copy()}>
          Копировать
        </button>
      </div>
      <span className="su-copied" aria-live="polite">
        {copied === 'copied'
          ? 'Скопировано'
          : copied === 'selected'
            ? 'Выделено – скопируйте вручную'
            : ''}
      </span>
    </div>
  );
}
