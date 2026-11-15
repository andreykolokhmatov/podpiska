import { Fragment } from 'react';

import type { IssueSource } from '@/pipeline/schema';

import { groupSeparator, groupSources } from './format';

interface BylineProps {
  sources: readonly IssueSource[];
  /** Inline bylines sit at the end of a brief/curio/event line instead of on their own row. */
  inline?: boolean;
}

export function Byline({ sources, inline = false }: BylineProps) {
  const groups = groupSources(sources);
  if (groups.length === 0) return null;
  const separator = groupSeparator(groups);
  const Tag = inline ? 'span' : 'div';

  return (
    <Tag className={inline ? 'byline byline--inline' : 'byline'}>
      {groups.map((group, gi) => (
        <Fragment key={group.links[0]!.href}>
          {gi > 0 && separator}
          {group.prefix !== null && `${group.prefix}: `}
          {group.links.map((link, li) => (
            <Fragment key={link.href}>
              {li > 0 && ' · '}
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.text}
              </a>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </Tag>
  );
}
