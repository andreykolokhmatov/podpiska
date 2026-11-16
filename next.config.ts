import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Both are on Next's built-in list already; kept explicit because the PDF route depends on it.
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],
  // The Brotli-packed Chromium is read from disk at runtime, so tracing cannot see it.
  outputFileTracingIncludes: {
    '/api/issues/\\[id\\]/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/app/issues/\\[id\\]/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
  async headers() {
    return [
      {
        source: '/issue/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        // Per-user data behind initData: never cached by the CDN or the WebView.
        source: '/api/app/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
