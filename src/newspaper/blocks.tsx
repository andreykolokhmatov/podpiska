import type { Issue as IssueDoc } from '@/pipeline/schema';

import { Byline } from './Byline';
import type { NewspaperCredit, NewspaperPromo } from './promo';
import { countLine, effectiveLayout, splitFeatureStories, unitKey, visibleFacts } from './format';

type Lead = IssueDoc['lead'];
type ValueNote = NonNullable<IssueDoc['weather']>;
type FrontSectionData = NonNullable<IssueDoc['frontSection']>;
type ArticleData = FrontSectionData['article'];
type SideSectionData = NonNullable<IssueDoc['sideSection']>;
type SectionData = NonNullable<IssueDoc['sections']>[number];
type StoryData = SectionData['stories'][number];
type Brief = NonNullable<IssueDoc['briefs']>[number];
type QuoteData = NonNullable<IssueDoc['quote']>;
type Curiosity = NonNullable<IssueDoc['curiosities']>[number];
type EventData = NonNullable<IssueDoc['events']>[number];

type HeadingTag = 'h2' | 'h3' | 'h4';

function Paragraphs({ paragraphs }: { paragraphs: readonly string[] }) {
  return paragraphs.map((text, i) => (
    <p key={`${i}|${text}`} className={i === 0 ? 'drop' : undefined}>
      {text}
    </p>
  ));
}

function SectionHead({ rubric, subtitle }: { rubric: string; subtitle?: string }) {
  return (
    <div className="sec">
      <h2>{rubric}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  );
}

interface MastheadProps {
  masthead: IssueDoc['masthead'];
  weather: ValueNote | undefined;
  numberOfDay: ValueNote | undefined;
}

export function Masthead({ masthead, weather, numberOfDay }: MastheadProps) {
  const ears = [
    weather && { key: 'weather', title: 'Погода в номере', note: weather },
    numberOfDay && { key: 'number', title: 'Цифра дня', note: numberOfDay },
  ].filter((ear) => ear !== undefined);

  return (
    <header className="mast">
      <div className="strip">
        <span>Выпуск № {masthead.number}</span>
        <span>{countLine(masthead.messages, masthead.channels)}</span>
      </div>
      <div className="name">Подписка</div>
      <div className="dateline">Новости за {masthead.dateline}</div>
      {ears.length > 0 ? (
        <div className={ears.length === 1 ? 'ears ears--single' : 'ears'}>
          {ears.map((ear) => (
            <div key={ear.key} className={`ear ear--${ear.key}`}>
              <small>{ear.title}</small>
              <b>{ear.note.value}</b>
              <span>{ear.note.text}</span>
              <Byline sources={ear.note.sources} />
            </div>
          ))}
        </div>
      ) : null}
    </header>
  );
}

export function LeadArticle({ lead }: { lead: Lead }) {
  const facts = visibleFacts(lead.facts);
  return (
    <article className="lead">
      {lead.kicker ? <div className="kick">{lead.kicker}</div> : null}
      <h1 className="hed">{lead.headline}</h1>
      {lead.deck ? <div className="deck">{lead.deck}</div> : null}
      {facts.length > 0 ? (
        <div className={`facts facts--${facts.length}`}>
          {facts.map((fact, i) => (
            <div key={unitKey(fact, fact.value, i)} className="fact">
              <b>{fact.value}</b>
              <span>{fact.text}</span>
              <Byline sources={fact.sources} />
            </div>
          ))}
        </div>
      ) : null}
      <Paragraphs paragraphs={lead.paragraphs} />
      <Byline sources={lead.sources} />
    </article>
  );
}

interface ArticleProps {
  article: ArticleData;
  heading: HeadingTag;
  className?: string;
}

function Article({ article, heading: Heading, className }: ArticleProps) {
  return (
    <article className={className}>
      <Heading className="hed">{article.headline}</Heading>
      {article.deck ? <div className="deck">{article.deck}</div> : null}
      <Paragraphs paragraphs={article.paragraphs} />
      {article.inverse ? (
        <div className="inverse">
          <div className="kick">{article.inverse.kicker}</div>
          <p>{article.inverse.text}</p>
          <Byline sources={article.inverse.sources} />
        </div>
      ) : null}
      <Byline sources={article.sources} />
    </article>
  );
}

function Story({ story, heading: Heading }: { story: StoryData; heading: HeadingTag }) {
  return (
    <div className="story">
      <Heading>{story.headline}</Heading>
      <p>{story.text}</p>
      <Byline sources={story.sources} />
    </div>
  );
}

function Stories({ stories, heading }: { stories: readonly StoryData[]; heading: HeadingTag }) {
  return stories.map((story, i) => (
    <Story key={unitKey(story, story.headline, i)} story={story} heading={heading} />
  ));
}

export function FrontSection({ section }: { section: FrontSectionData }) {
  return (
    <section className="front-section">
      <SectionHead rubric={section.rubric} subtitle={section.subtitle} />
      <Article article={section.article} heading="h3" />
    </section>
  );
}

export function SideSection({ section }: { section: SideSectionData }) {
  return (
    <section className="side-section">
      <SectionHead rubric={section.rubric} subtitle={section.subtitle} />
      <Stories stories={section.stories} heading="h3" />
    </section>
  );
}

export function Section({ section }: { section: SectionData }) {
  const { article } = section;
  if (effectiveLayout(section) === 'feature' && article) {
    const { list, extra } = splitFeatureStories(section.stories);
    const className =
      list.length > 0 ? 'section section--feature' : 'section section--feature section--no-list';
    return (
      <section className={className}>
        <SectionHead rubric={section.rubric} subtitle={section.subtitle} />
        <Article article={article} heading="h3" className="section__article" />
        {/* List (top-ranked stories) precedes extra so phones read it first; desktop places both via grid areas. */}
        {list.length > 0 ? (
          <div className="feature-list">
            <Stories stories={list} heading="h4" />
          </div>
        ) : null}
        {extra.length > 0 ? (
          <div className="feature-extra">
            <Stories stories={extra} heading="h4" />
          </div>
        ) : null}
      </section>
    );
  }

  const cols = Math.max(1, Math.min(section.stories.length, 3));
  return (
    <section className={`section section--grid section--cols-${cols}`}>
      <SectionHead rubric={section.rubric} subtitle={section.subtitle} />
      {article ? (
        <Article
          article={article}
          heading="h3"
          className="section__article section__article--wide"
        />
      ) : null}
      <Stories stories={section.stories} heading={article ? 'h4' : 'h3'} />
    </section>
  );
}

function withPeriod(label: string): string {
  return /[.!?…:]$/.test(label) ? label : `${label}.`;
}

export function Briefs({ briefs }: { briefs: readonly Brief[] }) {
  return (
    <aside className="brief">
      <h2>В двух словах</h2>
      <ul>
        {briefs.map((brief, i) => (
          <li key={unitKey(brief, brief.text, i)}>
            {brief.label ? <b>{withPeriod(brief.label)}</b> : null} {brief.text}{' '}
            <Byline sources={brief.sources} inline />
          </li>
        ))}
      </ul>
    </aside>
  );
}

function quoted(text: string): string {
  return /^[«"„“]/.test(text) ? text : `«${text}»`;
}

export function Quote({ quote }: { quote: QuoteData }) {
  return (
    <figure className="quote">
      <blockquote>{quoted(quote.text)}</blockquote>
      <figcaption>
        {quote.author ? `${quote.author} · ` : null}
        <Byline sources={quote.sources} inline />
      </figcaption>
    </figure>
  );
}

export function Curiosities({ items }: { items: readonly Curiosity[] }) {
  return (
    <aside className="curio">
      <h2>Курьёзы</h2>
      <ul>
        {items.map((item, i) => (
          <li key={unitKey(item, item.text, i)}>
            {item.text} <Byline sources={item.sources} inline />
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function Events({ events }: { events: readonly EventData[] }) {
  return (
    <section className="events">
      <SectionHead rubric="Афиша" />
      <div className="afisha">
        {events.map((event, i) => (
          <div key={unitKey(event, `${event.date} ${event.text}`, i)} className="ev">
            <b>{event.date}</b>
            <span>
              {event.text} <Byline sources={event.sources} inline />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface ColophonProps {
  text: string;
  number: number;
  promo?: NewspaperPromo | null | undefined;
  credit?: NewspaperCredit | null | undefined;
}

export function Colophon({ text, number, promo, credit }: ColophonProps) {
  return (
    <footer>
      <div className="colophon">{text}</div>
      <div className="end">Подписка · № {number}</div>
      {promo ? (
        <a
          className="promo"
          href={promo.url}
          target="_blank"
          rel="noopener noreferrer"
          data-promo-bot={promo.botUsername}
        >
          <span className="promo__lead">Соберите свою газету</span>{' '}
          <span className="promo__bot">→ @{promo.botUsername}</span>
        </a>
      ) : null}
      {credit ? (
        <a className="credit" href={credit.url} target="_blank" rel="noopener noreferrer">
          Сделано на Подписке · открытый код на GitHub
        </a>
      ) : null}
    </footer>
  );
}
