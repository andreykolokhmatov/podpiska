const TITLE_MAX = 100;

// Titles come from channel owners; replies are sent without parse_mode, so only length matters.
export const truncateTitle = (title: string): string =>
  title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;

const channelLabel = (username: string, title: string | null): string =>
  title === null || title.trim() === ''
    ? `@${username}`
    : `«${truncateTitle(title.trim())}» (@${username})`;

export const texts = {
  welcome: '📰 Подписка – ваша личная газета из Telegram-каналов.',
  openApp: 'Открыть Подписку',
  menuButton: 'Открыть',
  startCommand: 'Открыть Подписку',
  added: (username: string, title: string | null) =>
    `Канал ${channelLabel(username, title)} добавлен`,
  exists: (username: string, title: string | null) =>
    `Канал ${channelLabel(username, title)} уже в подписке`,
  limit: (max: number) => `Достигнут лимит: в подписке может быть не больше ${max} каналов.`,
  private:
    'Это приватный канал. Подписка читает только публичные каналы с адресом вида t.me/username.',
  notChannel:
    'Это не канал. Перешлите пост из публичного канала или пришлите ссылку вида t.me/username.',
  addlist: 'Папки пока не поддерживаются – пришлите каналы по одному.',
  notFound: 'Канал не найден, у него закрыто веб-превью или это не канал.',
  invalid: 'Не получилось разобрать адрес канала. Пришлите ссылку вида t.me/username.',
  retryLater: 'Telegram сейчас не отвечает. Попробуйте позже.',
  failure: 'Что-то пошло не так, попробуйте позже.',
  issueReady: (number: number) => `📰 Выпуск № ${number} готов`,
  openIssue: 'Читать выпуск',
} as const;
