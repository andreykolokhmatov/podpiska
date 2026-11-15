'use client';

import { Cell } from '@telegram-apps/telegram-ui';
import { Newspaper } from 'lucide-react';

import type { IssueSummary } from '@/miniapp/contract';

import { t } from '../texts';
import { ColorIcon } from './ColorIcon';

interface IssueCardProps {
  issue: IssueSummary;
  onOpen: (id: string) => void;
}

/** Latest issue as a rich native cell: date above, № as the title, lead headline below. */
export function IssueCard({ issue, onOpen }: IssueCardProps) {
  return (
    <Cell
      before={<ColorIcon icon={Newspaper} color="red" size={40} />}
      after={<span className="pd-link">{t.hub.read}</span>}
      subhead={issue.dateline}
      subtitle={issue.headline ? <span className="pd-clamp-3">{issue.headline}</span> : undefined}
      multiline
      onClick={() => onOpen(issue.id)}
    >
      <span className="pd-nowrap">{t.issueTitle(issue.number)}</span>
    </Cell>
  );
}
