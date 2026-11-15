import type { Metadata, Viewport } from 'next';

import { parseTheme } from '../issue/theme';
import { MiniAppBridge } from '@/miniapp/client/MiniAppBridge';

export const metadata: Metadata = {
  title: 'Политика конфиденциальности — Подписка',
  description: 'Какие данные собирает Подписка и куда они передаются',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

interface PrivacyPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const CSS = `
body{margin:0}
.pv{--bg:#fff;--fg:#1c1c1e;--muted:#6d6d72;--rule:#e5e5ea;--link:#007aff;
  color-scheme:light;background:var(--bg);color:var(--fg);min-height:100vh;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  padding:24px 16px calc(40px + env(safe-area-inset-bottom));box-sizing:border-box}
@media (prefers-color-scheme:dark){.pv:not([data-theme=light]){--bg:#000;--fg:#f2f2f7;--muted:#98989f;--rule:#2c2c2e;--link:#0a84ff;color-scheme:dark}}
.pv[data-theme=dark]{--bg:#000;--fg:#f2f2f7;--muted:#98989f;--rule:#2c2c2e;--link:#0a84ff;color-scheme:dark}
.pv main{max-width:640px;margin:0 auto}
.pv h1{font-size:26px;line-height:1.2;margin:0 0 4px}
.pv h2{font-size:18px;margin:28px 0 8px}
.pv p,.pv li{margin:0 0 10px}
.pv ul{padding-left:20px;margin:0 0 10px}
.pv .muted{color:var(--muted);font-size:14px}
.pv a{color:var(--link)}
.pv hr{border:0;border-top:1px solid var(--rule);margin:28px 0 16px}
`;

export default async function PrivacyPage({ searchParams }: PrivacyPageProps) {
  const theme = parseTheme((await searchParams).theme);
  return (
    <div className="pv" data-theme={theme}>
      <style>{CSS}</style>
      <main>
        <h1>Политика конфиденциальности</h1>
        <p className="muted">Подписка — персональная газета из Telegram-каналов.</p>

        <h2>Что мы храним</h2>
        <ul>
          <li>
            Ваш Telegram ID, имя пользователя и имя — их передаёт Telegram при открытии приложения.
          </li>
          <li>Список каналов, которые вы добавили в подписку.</li>
          <li>Текст ваших интересов.</li>
          <li>Собранные для вас выпуски газеты.</li>
        </ul>
        <p>
          Мы не храним номер телефона, переписку, список ваших чатов и подписок в Telegram. Посты мы
          берём только из публичных каналов через их открытую веб-версию.
        </p>

        <h2>Куда уходят данные</h2>
        <ul>
          <li>
            Текст ваших интересов и публичные посты выбранных каналов отправляются в языковую модель
            Google Gemini через сервис ProxyAPI, чтобы отобрать и пересказать новости.
          </li>
          <li>
            Ваш IP-адрес видит только хостинг (Vercel), на котором работает сервис. Мы его не
            сохраняем.
          </li>
          <li>Мы не продаём и не передаём данные никому, кроме перечисленных сервисов.</li>
        </ul>

        <h2>Как удалить данные</h2>
        <p>Каналы и интересы можно удалить в самом приложении в любой момент.</p>

        <hr />
        <p className="muted">
          Подписка — открытый проект: код доступен, сервис можно развернуть у себя со своим ключом.
        </p>
      </main>
      <MiniAppBridge />
    </div>
  );
}
