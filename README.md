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
