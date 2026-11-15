# Подписка

Персональная газета из публичных Telegram-каналов. Вы добавляете каналы и описываете, что вам
интересно. Сервис собирает посты, LLM отбирает и пересказывает главное, а выпуск свёрстан как
настоящая газета и открывается прямо в Telegram Mini App. У каждой заметки есть ссылки на
исходные посты.

Демо: [@podpiska_news_bot](https://t.me/podpiska_news_bot)

## Что умеет

- Нативная Telegram Mini App: каналы, интересы, архив выпусков, расписание.
- Газета: рубрики, главная тема, «В двух словах», цитата дня, афиша; светлая и тёмная тема.
- Расписание: каждый день, раз в 3 дня или раз в неделю, в выбранный час; бот присылает
  «Выпуск №N готов».
- Поделиться выпуском в любой чат (карточка открывает газету в Mini App), скачать PDF.
- Выжимка канала за день кэшируется и переиспользуется всеми читателями, поэтому LLM-расход
  растёт с числом каналов, а не пользователей.

## Стек

TypeScript, Next.js (App Router) на Vercel · grammY · Postgres (Neon) + Drizzle ·
Vercel AI SDK (по умолчанию Gemini) · @telegram-apps/telegram-ui · puppeteer-core +
@sparticuz/chromium для PDF · GitHub Actions как часовой будильник расписания · vitest.

## Свой экземпляр за ~15 минут

Нужно: Node.js 22.17+ или 24+, pnpm (через `corepack enable`), бесплатный Postgres
([Neon](https://neon.tech)), ключ Gemini, бот от [@BotFather](https://t.me/BotFather),
аккаунт Vercel.

1. Клонируйте и поставьте зависимости:
   ```sh
   git clone https://github.com/andreykolokhmatov/podpiska && cd podpiska
   corepack enable && pnpm install
   ```
2. Скопируйте `.env.example` в `.env` и заполните. Каждая переменная там описана.
3. Создайте таблицы: `pnpm db:migrate`.
4. Задеплойте на Vercel (регион `fra1`) и перенесите туда переменные из `.env`
   (`APP_URL` – адрес деплоя).
5. Настройте бота: `pnpm bot:setup` (webhook, кнопка меню). В @BotFather включите Main Mini
   App с URL деплоя.
6. Расписание: сгенерируйте `openssl rand -hex 32` и положите одно и то же значение в
   `CRON_SECRET` в Vercel и в GitHub → Settings → Secrets → Actions (`CRON_SECRET`,
   плюс `APP_URL`). Workflow `.github/workflows/tick.yml` будет будить сервер раз в час.

Собрать выпуск из консоли (тратит LLM): `pnpm issue --user <telegram_id> --days 1`.

## Разработка

```sh
pnpm dev                 # Next.js; /?mock=1 – Mini App на моках без Telegram
pnpm test                # vitest, без реальных LLM и сетевых вызовов
pnpm exec tsc --noEmit   # типы
pnpm lint
```

Газету без базы можно посмотреть на `/issue/preview?fixture=reference` (только в dev).

## Лицензия

MIT, см. [LICENSE](LICENSE).
