import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isFixtureName, loadFixture } from '@/newspaper/fixtures';
import { Newspaper } from '@/newspaper/Newspaper';

import { parseTheme } from '../theme';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Подписка · превью',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

interface PreviewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Dev-only fixture preview: /issue/preview?fixture=sample|reference|sparse&theme=light|dark. */
export default async function PreviewPage({ searchParams }: PreviewPageProps) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const query = await searchParams;
  const name = query.fixture ?? 'reference';
  if (!isFixtureName(name)) notFound();
  return <Newspaper issue={loadFixture(name)} theme={parseTheme(query.theme)} />;
}
