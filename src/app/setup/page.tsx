import type { Metadata, Viewport } from 'next';

import { SetupForm } from './SetupForm';

export const metadata: Metadata = {
  title: 'Проверка экземпляра – Подписка',
  description: 'Проверка и настройка своего экземпляра Подписки',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

const CSS = `
body{margin:0}
html,html *{scrollbar-width:none}
::-webkit-scrollbar{display:none}
.su{--bg:#fff;--fg:#1c1c1e;--muted:#6d6d72;--rule:#e5e5ea;--field:#f2f2f7;--accent:#007aff;--on-accent:#fff;
  --ok:#248a3d;--warn:#b25000;--fail:#d70015;
  color-scheme:light;background:var(--bg);color:var(--fg);min-height:100vh;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  padding:24px 16px calc(40px + env(safe-area-inset-bottom));box-sizing:border-box}
@media (prefers-color-scheme:dark){.su{--bg:#000;--fg:#f2f2f7;--muted:#98989f;--rule:#2c2c2e;--field:#1c1c1e;
  --accent:#0a84ff;--ok:#30d158;--warn:#ff9f0a;--fail:#ff453a;color-scheme:dark}}
.su *,.su *::before,.su *::after{box-sizing:border-box}
.su main{max-width:640px;margin:0 auto}
.su h1{font-size:26px;line-height:1.2;margin:0 0 8px}
.su h2{font-size:18px;margin:28px 0 8px}
.su p{margin:0 0 10px}
.su .muted{color:var(--muted);font-size:14px}
.su code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--field);padding:1px 5px;border-radius:5px}
.su label{display:block;font-size:14px;color:var(--muted);margin:0 0 4px}
.su input{width:100%;min-width:0;font:16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);
  background:var(--field);border:1px solid var(--rule);border-radius:10px;padding:10px 12px;-webkit-appearance:none;appearance:none}
.su input:focus{outline:2px solid var(--accent);outline-offset:1px}
.su button{font:inherit;font-weight:600;color:var(--on-accent);background:var(--accent);border:0;border-radius:10px;
  padding:11px 18px;cursor:pointer;-webkit-appearance:none;appearance:none}
.su button:disabled{opacity:.45;cursor:default}
.su button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.su .su-small{font-size:14px;padding:8px 12px;color:var(--accent);background:var(--field);border:1px solid var(--rule);flex:none}
.su-form{display:grid;gap:10px;margin:20px 0 16px}
.su-form label{margin:0}
.su-error{color:var(--fail)}
.su-ok-text{color:var(--ok)}
.su-overall{font-weight:600;display:flex;gap:8px;align-items:baseline;margin:20px 0 8px}
.su-checks{list-style:none;padding:0;margin:0 0 10px;border-top:1px solid var(--rule)}
.su-checks li{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--rule)}
.su-mark{flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:700;color:#fff;line-height:1;position:relative;top:1px}
.su-ok .su-mark{background:var(--ok)}
.su-warn .su-mark{background:var(--warn)}
.su-fail .su-mark{background:var(--fail)}
.su-ok.su-overall{color:var(--ok)}
.su-warn.su-overall{color:var(--warn)}
.su-fail.su-overall{color:var(--fail)}
.su-title{font-weight:500}
.su-hint{color:var(--muted);font-size:14px}
.su-actions{margin:16px 0 0}
.su-actions button{margin:0 0 8px}
.su-fields{display:grid;gap:12px;margin:12px 0 16px}
.su-row{display:flex;gap:6px;align-items:center}
.su-copied{display:block;min-height:18px;font-size:13px;color:var(--ok)}
.su-steps{padding-left:22px;margin:0 0 10px}
.su-steps li{margin:0 0 6px}
.su hr{border:0;border-top:1px solid var(--rule);margin:28px 0 16px}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;

export default function SetupPage() {
  return (
    <div className="su">
      <style>{CSS}</style>
      <main>
        <h1>Проверка экземпляра</h1>
        <p>Введите токен бота из @BotFather – он проверяется на сервере и нигде не сохраняется.</p>
        <SetupForm />
        <hr />
        <p className="muted">
          То же самое можно проверить локально: <code>pnpm selfhost:check</code> в папке проекта.
        </p>
      </main>
    </div>
  );
}
