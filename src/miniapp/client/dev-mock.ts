/**
 * DEV ONLY (`next dev` + `?mock=1`): fakes the Telegram environment and the /api/app backend so
 * the screens can be screenshotted in a plain browser. Loaded only through devMock.ts; production
 * builds never include it.
 *
 * Query: mock=1 · theme=light|dark · scenario=onboarding|hub|done|building|fresh
 */
import { emitEvent, mockTelegramEnv } from '@tma.js/sdk-react';

import type { ChannelView, IssueState, IssueSummary, MeResponse } from '@/miniapp/contract';

import type { FetchLike } from './api';

const THEMES = {
  light: {
    bg_color: '#ffffff',
    secondary_bg_color: '#efeff4',
    section_bg_color: '#ffffff',
    header_bg_color: '#f8f8f8',
    bottom_bar_bg_color: '#f2f2f2',
    text_color: '#000000',
    hint_color: '#8e8e93',
    subtitle_text_color: '#8e8e93',
    section_header_text_color: '#6d6d72',
    section_separator_color: '#c8c7cc',
    link_color: '#007aff',
    accent_text_color: '#007aff',
    button_color: '#007aff',
    button_text_color: '#ffffff',
    destructive_text_color: '#ff3b30',
  },
  dark: {
    bg_color: '#000000',
    secondary_bg_color: '#000000',
    section_bg_color: '#1c1c1d',
    header_bg_color: '#1a1a1a',
    bottom_bar_bg_color: '#1d1d1d',
    text_color: '#ffffff',
    hint_color: '#98989e',
    subtitle_text_color: '#98989e',
    section_header_text_color: '#8d8e93',
    section_separator_color: '#545458',
    link_color: '#3e88f7',
    accent_text_color: '#3e88f7',
    button_color: '#3e88f7',
    button_text_color: '#ffffff',
    destructive_text_color: '#eb5545',
  },
} as const;

type Scenario = 'onboarding' | 'hub' | 'done' | 'building' | 'fresh';

const ISSUE_ID = '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f';
const BUILD_ID = '0d9e8f7a-6b5c-4d3e-9f21-0a1b2c3d4e5f';

const ISSUES: IssueSummary[] = [4, 3, 2, 1].map((n) => ({
  id: n === 4 ? ISSUE_ID : `00000000-0000-4000-8000-00000000000${n}`,
  number: n,
  dateline: `${11 + n} ноября 2026`,
  headline:
    [
      'Омск утвердил бюджет на 2027 год: дефицит сократят вдвое',
      'Центробанк сохранил ставку, рубль укрепился к юаню',
      'В Омске открыли новый мост через Иртыш',
      'Цены на бензин в регионе выросли на 3% за месяц',
    ][4 - n] ?? null,
  createdAt: `2026-11-${String(11 + n).padStart(2, '0')}T06:00:00.000Z`,
}));

const CHANNELS: ChannelView[] = [
  { username: 'omsk_news', title: 'Новости Омска', avatarUrl: null, available: true },
  { username: 'rbc_news', title: 'РБК', avatarUrl: null, available: true },
  { username: 'banksta', title: 'Banksta', avatarUrl: null, available: true },
  { username: 'old_channel', title: 'Старый канал', avatarUrl: null, available: false },
];

function initialMe(scenario: Scenario): MeResponse {
  const base: MeResponse = {
    user: { telegramId: 1, firstName: 'Андрей', username: 'andrey' },
    onboarded: scenario !== 'onboarding',
    owner: false,
    channels: { count: CHANNELS.length, limit: 20 },
    hasInterests: false,
    latestIssue: ISSUES[0] ?? null,
    inFlight: null,
    quota: { limit: 3, used: 1, remaining: 2 },
  };
  switch (scenario) {
    case 'onboarding':
    case 'fresh':
      return { ...base, channels: { count: 0, limit: 20 }, latestIssue: null };
    case 'done':
      return { ...base, hasInterests: true };
    case 'building':
      return {
        ...base,
        hasInterests: true,
        inFlight: {
          id: BUILD_ID,
          status: 'digesting',
          progress: { step: 'digesting', done: 2, total: 4 },
          error: null,
          number: null,
        },
      };
    case 'hub':
      return base;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function createBackend(scenario: Scenario): FetchLike {
  const me = initialMe(scenario);
  let channels = scenario === 'onboarding' || scenario === 'fresh' ? [] : [...CHANNELS];
  let interests: string | null = me.hasInterests
    ? 'Коротко про новости Омска, больше про экономику'
    : null;
  let polls = 0;

  const buildState = (): IssueState => {
    polls += 1;
    const done = Math.min(4, 2 + Math.floor(polls / 2));
    return done < 4
      ? {
          id: BUILD_ID,
          status: 'digesting',
          progress: { step: 'digesting', done, total: 4 },
          error: null,
          number: null,
        }
      : {
          id: BUILD_ID,
          status: 'composing',
          progress: { step: 'composing', done: null, total: null },
          error: null,
          number: null,
        };
  };

  return async (input, init) => {
    await new Promise((r) => setTimeout(r, 150));
    const url = new URL(input, window.location.origin);
    const method = init.method ?? 'GET';
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const field = (key: string) =>
      body && typeof body === 'object' && key in body
        ? String((body as Record<string, unknown>)[key])
        : '';

    switch (`${method} ${url.pathname}`) {
      case 'GET /api/app/me':
        return json(200, {
          ...me,
          channels: { count: channels.length, limit: 20 },
          hasInterests: interests !== null,
        });
      case 'POST /api/app/onboarding':
        me.onboarded = true;
        return json(200, { onboardedAt: new Date().toISOString() });
      case 'GET /api/app/channels':
        return json(200, { channels, limit: 20 });
      case 'POST /api/app/channels': {
        const name = field('input')
          .replace(/^@|^https?:\/\/t\.me\//, '')
          .trim();
        if (!/^[a-z0-9_]{5,32}$/i.test(name)) return json(422, { error: 'invalid' });
        if (name.startsWith('private')) return json(422, { error: 'private' });
        const channel: ChannelView = {
          username: name,
          title: null,
          avatarUrl: null,
          available: true,
        };
        const exists = channels.some((c) => c.username === name);
        if (!exists) channels = [channel, ...channels];
        return json(exists ? 200 : 201, { status: exists ? 'exists' : 'added', channel });
      }
      case 'DELETE /api/app/channels':
        channels = channels.filter((c) => c.username !== field('username'));
        return json(200, { ok: true });
      case 'GET /api/app/interests':
        return json(200, { interests, maxLength: 500 });
      case 'PUT /api/app/interests':
        interests = field('interests').trim() || null;
        return json(200, { interests, maxLength: 500 });
      case 'GET /api/app/issues':
        return json(200, { issues: scenario === 'fresh' ? [] : ISSUES, nextBefore: null });
      case 'POST /api/app/issues':
        return json(202, { issue: buildState(), quota: { limit: 3, used: 2, remaining: 1 } });
      case `GET /api/app/issues/${BUILD_ID}`:
        return json(200, { issue: buildState() });
      default:
        return json(404, { error: 'not_found' });
    }
  };
}

/** Visual stand-ins for the native buttons Telegram would draw outside the WebView. */
function nativeChrome(theme: (typeof THEMES)[keyof typeof THEMES]) {
  const main = document.createElement('button');
  main.id = 'mock-main-button';
  Object.assign(main.style, {
    position: 'fixed',
    left: '12px',
    right: '12px',
    bottom: '12px',
    height: '50px',
    border: '0',
    borderRadius: '12px',
    font: '600 17px -apple-system, system-ui, sans-serif',
    background: theme.button_color,
    color: theme.button_text_color,
    display: 'none',
    zIndex: '1000',
  });
  main.onclick = () => emitEvent('main_button_pressed');
  const back = document.createElement('button');
  back.id = 'mock-back-button';
  back.textContent = '‹ Назад';
  Object.assign(back.style, {
    position: 'fixed',
    left: '8px',
    top: '8px',
    padding: '6px 12px',
    border: '0',
    borderRadius: '16px',
    font: '500 15px -apple-system, system-ui, sans-serif',
    background: theme.section_bg_color,
    color: theme.link_color,
    boxShadow: '0 1px 4px rgba(0,0,0,.15)',
    display: 'none',
    zIndex: '1000',
  });
  back.onclick = () => emitEvent('back_button_pressed');
  document.body.append(main, back);
  document.body.style.paddingBottom = '74px';
  document.body.style.paddingTop = '36px';

  return {
    main(params: Record<string, unknown>) {
      main.style.display = params.is_visible ? 'block' : 'none';
      main.style.opacity = params.is_active === false ? '0.55' : '1';
      main.textContent = params.is_progress_visible ? '…' : String(params.text ?? '');
      main.style.backgroundImage = params.has_shine_effect
        ? 'linear-gradient(100deg, transparent 30%, rgba(255,255,255,.25) 50%, transparent 70%)'
        : '';
    },
    back(params: Record<string, unknown>) {
      back.style.display = params.is_visible ? 'block' : 'none';
    },
  };
}

export function installDevMock(search: string): FetchLike {
  const query = new URLSearchParams(search);
  const theme = THEMES[query.get('theme') === 'dark' ? 'dark' : 'light'];
  const scenarioParam = query.get('scenario');
  const scenario: Scenario =
    scenarioParam === 'onboarding' ||
    scenarioParam === 'done' ||
    scenarioParam === 'building' ||
    scenarioParam === 'fresh'
      ? scenarioParam
      : 'hub';
  const chrome = nativeChrome(theme);
  const user = {
    id: 1,
    first_name: 'Андрей',
    last_name: 'К',
    username: 'andrey',
    language_code: 'ru',
  };

  mockTelegramEnv({
    resetPostMessage: true,
    launchParams: {
      tgWebAppPlatform: 'ios',
      tgWebAppVersion: '9.1',
      tgWebAppThemeParams: theme,
      tgWebAppData: new URLSearchParams({
        user: JSON.stringify(user),
        auth_date: String(Math.floor(Date.now() / 1000)),
        hash: 'dev-mock',
        signature: 'dev-mock',
      }),
    },
    onEvent(event) {
      const params = (event.params ?? {}) as Record<string, unknown>;
      switch (event.name) {
        case 'web_app_request_theme':
          emitEvent('theme_changed', { theme_params: theme });
          return;
        case 'web_app_request_viewport':
          emitEvent('viewport_changed', {
            height: window.innerHeight,
            width: window.innerWidth,
            is_expanded: true,
            is_state_stable: true,
          });
          return;
        case 'web_app_request_safe_area':
          emitEvent('safe_area_changed', { top: 0, bottom: 0, left: 0, right: 0 });
          return;
        case 'web_app_request_content_safe_area':
          emitEvent('content_safe_area_changed', { top: 0, bottom: 0, left: 0, right: 0 });
          return;
        case 'web_app_setup_main_button':
          chrome.main(params);
          return;
        case 'web_app_setup_back_button':
          chrome.back(params);
          return;
        case 'web_app_open_popup':
          emitEvent(
            'popup_closed',
            window.confirm(String(params.message ?? '')) ? { button_id: 'confirm' } : {},
          );
          return;
        default:
          return;
      }
    },
  });
  return createBackend(scenario);
}
