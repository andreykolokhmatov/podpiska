import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isFixtureName, loadFixture } from '@/newspaper/fixtures';
import { Newspaper } from '@/newspaper/Newspaper';
import { type NewspaperPromo, UPSTREAM_REPO_URL } from '@/newspaper/promo';

import { parseTheme } from '../theme';

export const dynamic = 'force-dynamic';

const SAMPLE_PROMO: NewspaperPromo = {
  botUsername: 'podpiska_news_bot',
  url: 'https://t.me/podpiska_news_bot',
};

export const metadata: Metadata = {
  title: 'Подписка · превью',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

interface PreviewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Dev-only fixture preview: /issue/preview?fixture=sample|reference|sparse&theme=light|dark&promo=0&credit=0. */
export default async function PreviewPage({ searchParams }: PreviewPageProps) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const query = await searchParams;
  const name = query.fixture ?? 'reference';
  if (!isFixtureName(name)) notFound();
  return (
    <Newspaper
      issue={loadFixture(name)}
      theme={parseTheme(query.theme)}
      promo={query.promo === '0' ? null : SAMPLE_PROMO}
      credit={query.credit === '0' ? null : { url: UPSTREAM_REPO_URL }}
    />
  );
}
