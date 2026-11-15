import { texts as botTexts } from '@/bot/texts';
import {
  DAILY_BUILDS,
  INTERESTS_MAX,
  type ApiErrorCode,
  type IssueErrorCode,
} from '@/miniapp/contract';

/** Client-only failure: fetch rejected or the response was not the contract's JSON. */
export type ClientErrorCode = ApiErrorCode | 'network';

export const BOT_URL = 'https://t.me/podpiska_news_bot';

const restart = 'Закройте и откройте приложение заново.';

export const apiErrorText: Record<ClientErrorCode, string> = {
  unauthorized: `Не получилось проверить вход. ${restart}`,
  expired: `Сессия устарела. ${restart}`,
  bad_request: 'Некорректный запрос. Обновите приложение и попробуйте ещё раз.',
  not_found: 'Не нашли то, что вы ищете. Возможно, его уже удалили.',
  too_long: `Слишком длинный текст: не больше ${INTERESTS_MAX} символов.`,
  busy: 'Выпуск уже собирается — дождитесь его.',
  limit: `На сегодня выпуски закончились: не больше ${DAILY_BUILDS} в день. Возвращайтесь завтра.`,
  limit_global: 'Редакция сегодня перегружена. Попробуйте собрать выпуск завтра.',
  no_channels: 'Сначала добавьте хотя бы один канал.',
  channel_limit: 'Достигнут лимит каналов в подписке.',
  private: botTexts.private,
  invalid: botTexts.invalid,
  channel_not_found: botTexts.notFound,
  retry_later: botTexts.retryLater,
  misconfigured: 'Сервис настроен не до конца. Попробуйте позже.',
  internal: botTexts.failure,
  network: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
};

/** channel_limit carries the actual max; everything else is static copy. */
export function errorText(code: ClientErrorCode, limit?: number): string {
  if (code === 'channel_limit' && limit !== undefined) return botTexts.limit(limit);
  return apiErrorText[code];
}

export const issueErrorText: Record<IssueErrorCode, string> = {
  no_channels: 'В подписке нет каналов — добавьте хотя бы один.',
  no_posts: 'В ваших каналах не нашлось новых постов за последние сутки.',
  collect_failed: 'Не получилось прочитать каналы: Telegram не ответил. Попробуйте позже.',
  digest_failed: 'Редакция не смогла прочитать каналы. Попробуйте ещё раз.',
  no_news: 'За сутки не нашлось ничего по вашим интересам.',
  timeout: 'Сборка заняла слишком много времени. Попробуйте ещё раз.',
  internal: 'Что-то пошло не так при сборке. Попробуйте ещё раз.',
};

export const t = {
  appName: 'Подписка',
  outside: {
    title: 'Откройте в Telegram',
    text: 'Подписка работает внутри Telegram: там она собирает газету из ваших каналов.',
    button: 'Открыть @podpiska_news_bot',
  },
  loadFailed: 'Не удалось загрузить',
  retry: 'Повторить',
  onboarding: {
    accent: 'Ваша личная газета',
    title: 'Весь Telegram в одной подписке',
    benefits: [
      {
        id: 'channels',
        title: 'Любые публичные каналы',
        subtitle: 'Добавьте каналы — подписываться на них не нужно',
      },
      {
        id: 'interests',
        title: 'Только то, что вам интересно',
        subtitle: 'Опишите интересы своими словами — редакция отберёт главное',
      },
      {
        id: 'paper',
        title: 'Свёрстано как газета',
        subtitle: 'Каждая заметка ведёт на исходный пост в канале',
      },
    ],
    privacy: 'Политика конфиденциальности',
    start: 'НАЧАТЬ',
  },
  hub: {
    add: 'Добавить канал',
    checklistHeader: 'НАЧАЛО РАБОТЫ',
    steps: {
      channels: {
        title: 'Добавьте каналы',
        subtitle: 'Откуда брать новости',
      },
      interests: { title: 'Опишите интересы', subtitle: 'Что важно, а что пропустить' },
      issue: { title: 'Соберите первый выпуск', subtitle: 'Нажмите «Собрать выпуск» внизу' },
    },
    latestHeader: 'ПОСЛЕДНИЙ ВЫПУСК',
    menuHeader: 'НАСТРОЙКИ',
    channels: 'Каналы',
    channelsEmpty: 'Пока нет каналов',
    interests: 'Интересы',
    interestsSet: 'Заданы',
    interestsEmpty: 'Не заданы',
    archive: 'Архив',
    archiveSubtitle: 'Все выпуски',
    build: 'СОБРАТЬ ВЫПУСК',
    buildingTitle: 'Выпуск собирается',
    buildingSubtitle: 'Обычно это занимает 1–3 минуты',
    failedTitle: 'Не удалось собрать выпуск',
    slowTitle: 'Собирается дольше обычного',
    slowSubtitle: 'Загляните чуть позже — выпуск появится в архиве',
    openingTitle: 'Выпуск готов',
    openingSubtitle: 'Открываем газету…',
  },
  progress: {
    collecting: 'Собираем посты…',
    digestingCounted: (done: number, total: number) => `Читаем каналы ${done}/${total}`,
    digesting: 'Читаем каналы…',
    composing: 'Верстаем номер…',
  },
  channels: {
    addHeader: 'ДОБАВИТЬ КАНАЛ',
    placeholder: '@username или t.me/username',
    addFooter: 'Только публичные каналы. Можно вставить ссылку на канал или на пост.',
    add: 'ДОБАВИТЬ',
    listHeader: (count: number, limit: number) => `КАНАЛЫ · ${count} ИЗ ${limit}`,
    unavailable: 'Не получилось прочитать канал',
    remove: 'Удалить',
    confirmTitle: 'Удалить канал?',
    confirmText: (name: string) => `${name} больше не попадёт в ваши выпуски.`,
    emptyTitle: 'Пока нет каналов',
    emptyText: 'Добавьте первый канал — например, @username любимого издания.',
    added: (name: string) => `${name} добавлен`,
    exists: (name: string) => `${name} уже в подписке`,
  },
  interests: {
    header: 'ЧТО ВАМ ИНТЕРЕСНО',
    placeholder: 'Например: коротко про новости Омска, больше про экономику, без спорта',
    counter: (n: number) => `${n} / ${INTERESTS_MAX}`,
    footer: 'Редакция использует это только чтобы отбирать и сокращать новости.',
    examplesHeader: 'ПРИМЕРЫ',
    examples: [
      'Больше про экономику',
      'Коротко про политику',
      'Технологии и ИИ',
      'Новости моего города',
      'Без спорта',
      'Наука и космос',
    ],
    save: 'СОХРАНИТЬ',
  },
  archive: {
    header: 'ВЫПУСКИ',
    more: 'Показать ещё',
    emptyTitle: 'Выпусков пока нет',
    emptyText: 'Соберите первый выпуск на главной — он появится здесь.',
  },
  issueTitle: (number: number) => `Выпуск № ${number}`,
  issueMeta: (number: number, dateline: string) => `№ ${number} · ${dateline}`,
} as const;
