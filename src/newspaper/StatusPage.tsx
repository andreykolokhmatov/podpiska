import type { NewspaperTheme } from './Newspaper';

interface StatusPageProps {
  title: string;
  text: string;
  theme?: NewspaperTheme | undefined;
}

/** Non-issue states (building / failed / invalid / not found) on the same paper. */
export function StatusPage({ title, text, theme }: StatusPageProps) {
  return (
    <div className="np" data-theme={theme} suppressHydrationWarning>
      <div className="paper">
        <header className="mast">
          <div className="name">Подписка</div>
        </header>
        <main className="status">
          <h1>{title}</h1>
          <p>{text}</p>
        </main>
      </div>
    </div>
  );
}

export const STATUS_COPY = {
  building: {
    title: 'Выпуск собирается',
    text: 'Редакция читает каналы и верстает номер. Загляните через пару минут.',
  },
  failed: {
    title: 'Не удалось собрать выпуск',
    text: 'Что-то пошло не так при сборке номера. Попробуем ещё раз в следующий выпуск.',
  },
  invalid: {
    title: 'Ошибка выпуска',
    text: 'Номер сохранился в неверном формате, и показать его не получается.',
  },
  'not-found': {
    title: 'Выпуск не найден',
    text: 'Возможно, ссылка неполная или выпуск удалён.',
  },
} as const satisfies Record<string, { title: string; text: string }>;
