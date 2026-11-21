import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { loadIssueView } from '@/newspaper/load';
import { Newspaper } from '@/newspaper/Newspaper';
import { newspaperCredit, newspaperPromo } from '@/newspaper/promo';
import { STATUS_COPY, StatusPage } from '@/newspaper/StatusPage';

import { parseTheme } from '../theme';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IssuePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PRIVATE: Pick<Metadata, 'robots' | 'referrer'> = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export async function generateMetadata({ params }: IssuePageProps): Promise<Metadata> {
  const { id } = await params;
  const view = await loadIssueView(id);
  if (view.kind !== 'ready') return { title: 'Подписка', ...PRIVATE };
  const title = `Подписка № ${view.issue.masthead.number}`;
  return {
    title,
    description: `Новости за ${view.issue.masthead.dateline}`,
    openGraph: { title },
    ...PRIVATE,
  };
}

export default async function IssuePage({ params, searchParams }: IssuePageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const theme = parseTheme(query.theme);
  const view = await loadIssueView(id);

  switch (view.kind) {
    case 'not-found':
      notFound();
    case 'ready':
      return (
        <Newspaper
          issue={view.issue}
          theme={theme}
          promo={newspaperPromo()}
          credit={newspaperCredit()}
        />
      );
    default:
      return <StatusPage {...STATUS_COPY[view.kind]} theme={theme} />;
  }
}
