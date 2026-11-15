# Подписка

Персональная газета из Telegram-каналов. Вы даёте список публичных каналов и описываете
промптом, что вам интересно. По расписанию (раз в день или в неделю) сервис собирает посты,
LLM отбирает и пересказывает главное, а результат свёрстан как газета и открывается в
Telegram Mini App. Бот присылает свежий выпуск.

> Статус: ранняя разработка. Сейчас готовы каркас проекта и схема базы данных.

## Стек

- TypeScript (strict), pnpm
- Next.js (App Router): Mini App и API routes, деплой на Vercel
- Бот: grammY, webhook
- База: Postgres (Neon или любой другой) + Drizzle ORM, миграции drizzle-kit
- LLM: Vercel AI SDK, по умолчанию Gemini
- Очередь и расписание: Upstash QStash
- Тесты: vitest

## Что нужно

- Node.js 20.9 или новее (рекомендуется 24 LTS)
- corepack (входит в Node.js до 24 включительно; в Node 25+ поставьте: `npm i -g corepack`) — через него ставится нужная версия pnpm
- Postgres: бесплатная база в [Neon](https://neon.tech) или локальный Postgres

## Локальный запуск

1. Склонируйте репозиторий:
   ```sh
   git clone <url-репозитория> podpiska
   cd podpiska
   ```
2. Включите corepack (если нужен root, используйте
   `corepack enable --install-directory ~/.local/bin` или вызывайте `corepack pnpm`):
   ```sh
   corepack enable
   ```
3. Установите зависимости:
   ```sh
   pnpm install
   ```
4. Создайте `.env` из шаблона:
   ```sh
   cp .env.example .env
   ```
5. Впишите в `.env` строку подключения `DATABASE_URL` (для Neon — ещё и
   `DATABASE_URL_UNPOOLED`, прямое подключение без пулера). Описание всех переменных —
   в комментариях `.env.example`.
6. Создайте таблицы:
   ```sh
   pnpm db:migrate
   ```
7. Запустите dev-сервер и откройте http://localhost:3000:
   ```sh
   pnpm dev
   ```

## Mini App

Весь продукт — Telegram Mini App по адресу `APP_URL` (корень сайта). Бот только открывает её
и присылает уведомление о готовом выпуске.

1. Примените миграции (Mini App хранит отметку онбординга в `users.onboarded_at`):
   ```sh
   pnpm db:migrate
   ```
2. В [@BotFather](https://t.me/BotFather) для бота из `TELEGRAM_BOT_TOKEN`:
   - **Bot Settings → Configure Mini App → Enable Mini App**, URL = `APP_URL`
     (например `https://podpiska-news.vercel.app`) — это Main Mini App, кнопка «Открыть» в
     профиле бота;
   - **Bot Settings → Menu Button**, URL = тот же `APP_URL`.
3. Необязательно, в `.env` / Vercel:
   - `TELEGRAM_DEV_BOT_TOKEN` — токен второго (dev) бота, у которого в BotFather указан тот же
     `APP_URL`. Его initData принимается API, но владельцем он никогда не считается.
   - `OWNER_TELEGRAM_ID` — ваш числовой Telegram id: без дневного лимита «Собрать выпуск»
     (только когда Mini App открыта из основного бота).
   - `MAX_BUILDS_PER_DAY_GLOBAL` — общий дневной лимит сборок на всех (по умолчанию 30).

Mini App работает только внутри Telegram: в обычном браузере `/` показывает «Откройте в
Telegram» и не обращается к API. Газета `/issue/<id>` и `/privacy` открываются и в браузере.

Для вёрстки без Telegram есть dev-мок (только `pnpm dev`, в production-сборку не попадает):
`http://localhost:3000/?mock=1&theme=dark&scenario=hub` — подменяет окружение Telegram и
ответы API фикстурами; `scenario` = `onboarding` | `hub` | `done` | `building` | `fresh`.

## Скрипты

| Команда            | Что делает                                       |
| ------------------ | ------------------------------------------------ |
| `pnpm dev`         | dev-сервер Next.js                               |
| `pnpm build`       | production-сборка                                |
| `pnpm start`       | запуск production-сборки                         |
| `pnpm test`        | тесты (vitest)                                   |
| `pnpm lint`        | ESLint                                           |
| `pnpm typecheck`   | проверка типов TypeScript                        |
| `pnpm format`      | форматирование Prettier                          |
| `pnpm db:generate` | сгенерировать SQL-миграцию из `src/db/schema.ts` |
| `pnpm db:migrate`  | применить миграции к базе                        |

## Дорожная карта

1. Каркас и база данных ← сейчас здесь
2. Сборщик постов из публичных каналов
3. LLM-пайплайн и вёрстка газеты
4. Telegram-бот
5. Mini App
6. Деплой на Vercel
7. Расписание выпусков
8. Оплата Telegram Stars и свой ключ LLM (BYOK)

## Лицензия

[MIT](LICENSE)
