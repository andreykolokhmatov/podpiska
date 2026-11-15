import type { Issue as IssueDoc } from '@/pipeline/schema';

import {
  Briefs,
  Colophon,
  Curiosities,
  Events,
  FrontSection,
  LeadArticle,
  Masthead,
  Quote,
  Section,
  SideSection,
} from './blocks';
import { isSectionEmpty } from './format';

export type NewspaperTheme = 'light' | 'dark';

interface NewspaperProps {
  issue: IssueDoc;
  /** Forced theme; without it the tokens follow prefers-color-scheme (or the Telegram theme script). */
  theme?: NewspaperTheme | undefined;
}

/** The whole issue as static markup: slots are placed by class, mobile order comes from CSS. */
export function Newspaper({ issue, theme }: NewspaperProps) {
  const briefs = issue.briefs ?? [];
  const curiosities = issue.curiosities ?? [];
  const events = issue.events ?? [];
  const sections = (issue.sections ?? []).filter((section) => !isSectionEmpty(section));
  const hasSide = briefs.length > 0 || issue.quote !== undefined || issue.sideSection !== undefined;

  return (
    <div className="np" data-theme={theme} suppressHydrationWarning>
      <div className="paper">
        <Masthead
          masthead={issue.masthead}
          weather={issue.weather}
          numberOfDay={issue.numberOfDay}
        />
        <main>
          <div className={hasSide ? 'front' : 'front front--solo'}>
            <div className="main-col">
              <LeadArticle lead={issue.lead} />
              {issue.frontSection ? <FrontSection section={issue.frontSection} /> : null}
              {curiosities.length > 0 ? <Curiosities items={curiosities} /> : null}
            </div>
            {hasSide ? (
              <div className="side-col">
                {briefs.length > 0 ? <Briefs briefs={briefs} /> : null}
                {issue.quote ? <Quote quote={issue.quote} /> : null}
                {issue.sideSection ? <SideSection section={issue.sideSection} /> : null}
              </div>
            ) : null}
          </div>
          {sections.length > 0 ? (
            <div className="lower">
              {sections.map((section, i) => (
                <Section
                  key={`${section.rubric}|${section.article?.headline ?? section.stories[0]?.headline ?? ''}|${i}`}
                  section={section}
                />
              ))}
            </div>
          ) : null}
          {events.length > 0 ? <Events events={events} /> : null}
        </main>
        <Colophon text={issue.colophon} number={issue.masthead.number} />
      </div>
    </div>
  );
}
