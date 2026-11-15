import type { LaunchBrowser } from './render';

/**
 * Launches headless Chromium: the bundled @sparticuz/chromium (Vercel/Lambda), or a local
 * binary when `executablePath` is given. Imported lazily so a cold start of any other route
 * never loads puppeteer.
 */
export function createChromiumLauncher(options: {
  executablePath?: string | undefined;
}): LaunchBrowser {
  return async () => {
    const { default: puppeteer } = await import('puppeteer-core');
    if (options.executablePath !== undefined) {
      const browser = await puppeteer.launch({
        executablePath: options.executablePath,
        headless: 'shell',
      });
      return browser;
    }
    const { default: chromium } = await import('@sparticuz/chromium');
    chromium.setGraphicsMode = false;
    const browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    });
    return browser;
  };
}
