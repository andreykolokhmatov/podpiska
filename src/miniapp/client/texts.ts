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
  busy: 'Выпуск уже собирается – дождитесь его.',
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
  cannot_message: 'Бот не может вам написать. Откройте чат с ботом, нажмите «Старт» и попробуйте ещё раз.',
  network: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
};

/** channel_limit carries the actual max; everything else is static copy. */
export function errorText(code: ClientErrorCode, limit?: number): string {
  if (code === 'channel_limit' && limit !== undefined) return botTexts.limit(limit);
  return apiErrorText[code];
}

const notCounted = 'Попытка не засчитана.';

export const issueErrorText: Record<IssueErrorCode, string> = {
  no_channels: 'В подписке нет каналов – добавьте хотя бы один.',
  no_posts: `В ваших каналах не было постов за последние сутки. ${notCounted}`,
  collect_failed: `Не получилось прочитать каналы: Telegram не ответил. Попробуйте позже. ${notCounted}`,
  digest_failed: 'Редакция не смогла прочитать каналы. Попробуйте ещё раз.',
  no_news: `Посты за сутки есть, но новостей среди них нет – только личные заметки, репосты или мемы. Добавьте каналы, где пишут новости. ${notCounted}`,
  timeout: 'Сборка заняла слишком много времени. Попробуйте ещё раз.',
  internal: 'Что-то пошло не так при сборке. Попробуйте ещё раз.',
};

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const pluralIssues = (n: number) => plural(n, 'выпуск', 'выпуска', 'выпусков');

/**
 * no_news names what was read, so the reader sees the channels are the problem (digests do not
 * depend on interests). "в 1 из 2 каналов" also tells that the other channel was silent.
 */
export function issueFailureText(
  code: IssueErrorCode,
  found: { posts: number; channels: number } | undefined,
  channelCount: number,
): string {
  if (code !== 'no_news' || !found || found.posts === 0) return issueErrorText[code];
  const where =
    found.channels < channelCount
      ? `в ${found.channels} из ${channelCount} ${plural(channelCount, 'канала', 'каналов', 'каналов')}`
      : 'в ваших каналах';
  const posts = `${found.posts.toString()} ${plural(found.posts, 'пост', 'поста', 'постов')}`;
  return `${posts} за сутки ${where} – и ни одной новости: только личные заметки, репосты или мемы. Добавьте каналы, где пишут новости. ${notCounted}`;
}

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
    title: 'Весь Telegram в одной подписке',
    text: 'Добавьте публичные каналы и расскажите, что вам интересно. Подписка соберёт из них газету.',
    features: [
      { id: 'channels', text: 'Любые публичные каналы – без подписки на них' },
      { id: 'interests', text: 'Отбор и пересказ по вашим интересам' },
      { id: 'paper', text: 'Как настоящая газета: рубрики и ссылка на каждый пост' },
    ],
    privacy: 'Политика конфиденциальности',
    start: 'НАЧАТЬ',
  },
  hub: {
    title: 'Подписка',
    latestHeader: 'ПОСЛЕДНИЙ ВЫПУСК',
    read: 'Читать',
    emptyTitle: 'Здесь появится ваша газета',
    emptyNoChannels: 'Добавьте каналы ниже, и редакция соберёт из них первый выпуск.',
    emptyReady: 'Нажмите «Собрать выпуск» – первый номер будет готов через пару минут.',
    channelsHeader: (count: number) => (count > 0 ? `КАНАЛЫ · ${count}` : 'КАНАЛЫ'),
    addChannel: 'Добавить канал',
    showAll: (count: number) => `Показать все (${count})`,
    channelsFooter: 'Только публичные каналы. Подписываться на них не нужно.',
    interestsHeader: 'ИНТЕРЕСЫ',
    interestsEmpty: 'Не заданы',
    interestsEmptyHint: 'Расскажите, о чём писать подробнее, а что пропускать',
    interestsFooter: 'Редакция отбирает и сокращает новости по этому описанию.',
    archive: 'Архив выпусков',
    quotaLeft: (n: number) => `Можно собрать ещё ${n} ${pluralIssues(n)} сегодня.`,
    quotaNone: 'На сегодня выпуски закончились – завтра можно снова.',
    needChannels: 'Чтобы собрать выпуск, добавьте хотя бы один канал.',
    build: 'СОБРАТЬ ВЫПУСК',
    buildNow: 'Собрать сейчас',
    buildingTitle: 'Выпуск собирается',
    buildingSubtitle: 'Обычно это занимает 1–3 минуты',
    failedTitle: 'Не удалось собрать выпуск',
    slowTitle: 'Собирается дольше обычного',
    slowSubtitle: 'Загляните чуть позже – выпуск появится в архиве',
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
    emptyText: 'Добавьте первый канал – например, @username любимого издания.',
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
    emptyText: 'Соберите первый выпуск на главной – он появится здесь.',
    edit: 'Изменить',
    done: 'Готово',
    editFooter: 'Нажмите на выпуск, чтобы удалить его.',
    deleteLabel: (number: number) => `Удалить выпуск №\u00A0${number}`,
    deleteTitle: (number: number) => `Удалить выпуск №\u00A0${number}?`,
    deleteText: 'Выпуск пропадёт из архива, ссылка на него перестанет открываться.',
    deleteConfirm: 'Удалить',
    deleteBusy: 'Этот выпуск ещё собирается – удалить его можно после сборки.',
  },
  schedule: {
    hubHeader: 'СЛЕДУЮЩИЙ ВЫПУСК',
    off: 'Выключено',
    pausedLine: 'Приостановлено – включите снова',
    needIssue: 'Начнётся после первого выпуска',
    needPermission: 'Нужно разрешение на сообщения',
    switchLabel: 'Собирать автоматически',
    frequencyHeader: 'КАК ЧАСТО',
    frequencies: { 1: 'Каждый день', 3: 'Раз в 3 дня', 7: 'Раз в неделю' },
    frequencyShort: { 1: 'каждый день', 3: 'раз в 3 дня', 7: 'раз в неделю' },
    time: 'Время выхода',
    today: 'сегодня',
    tomorrow: 'завтра',
    timeZone: (name: string) => `Часовой пояс: ${name}`,
    offNote: 'Газета будет приходить в бот сама – в выбранный день и час.',
    pausedNote:
      'Приостановлено: последние выпуски остались непрочитанными или бот не смог их прислать. Включите, чтобы продолжить.',
    firstIssueNote:
      'Первый автоматический выпуск придёт после того, как вы соберёте газету вручную.',
    permissionNote: 'Чтобы присылать выпуски, боту нужно разрешение писать вам.',
    deniedNote: 'Без разрешения на сообщения бот не сможет присылать выпуски.',
    nextNote: (when: string) => `Следующий выпуск – ${when}.`,
    save: 'СОХРАНИТЬ',
  },
  issueActions: {
    share: 'Поделиться',
    pdf: 'PDF в чат',
    trigger: 'Поделиться выпуском или получить PDF',
    menuTitleBare: 'Выпуск',
    menuText: 'Отправьте газету в чат или получите PDF в чат с ботом.',
    errorTitle: 'Не получилось',
    shareFailed: 'Не удалось поделиться выпуском. Попробуйте ещё раз.',
    pdfFailed: 'Не удалось отправить PDF. Попробуйте ещё раз.',
    pdfSentTitle: 'PDF отправлен',
    pdfSent: 'Файл уже в чате с ботом.',
  },
  issueTitle: (number: number) => `Выпуск №\u00A0${number}`,
  issueMeta: (number: number, dateline: string) => `№ ${number} · ${dateline}`,
} as const;
