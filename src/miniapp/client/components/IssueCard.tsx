'use client';

import { Cell, Section } from '@telegram-apps/telegram-ui';
import { ChevronRight, Newspaper } from 'lucide-react';

import type { IssueSummary } from '@/miniapp/contract';

import { t } from '../texts';
import { ColorIcon } from './ColorIcon';

interface IssueCardProps {
  issue: IssueSummary;
  onOpen: (id: string) => void;
}

export function IssueCard({ issue, onOpen }: IssueCardProps) {
  return (
    <Section header={t.hub.latestHeader}>
      <Cell
        before={<ColorIcon icon={Newspaper} color="red" size={40} />}
        after={<ChevronRight className="pd-chevron" size={20} />}
        subhead={t.issueMeta(issue.number, issue.dateline)}
        multiline
        onClick={() => onOpen(issue.id)}
      >
        <span className="pd-headline">{issue.headline ?? t.issueTitle(issue.number)}</span>
      </Cell>
    </Section>
  );
}
