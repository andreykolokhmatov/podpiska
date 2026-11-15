// The only entry point to the dev mock. `process.env.NODE_ENV` is inlined at build time, so the
// production bundle keeps `null` and never contains the mock chunk (see devMock.test.ts).
export const loadDevMock =
  process.env.NODE_ENV === 'development' ? () => import('./dev-mock') : null;

export const wantsDevMock = (search: string): boolean =>
  loadDevMock !== null && new URLSearchParams(search).get('mock') === '1';
