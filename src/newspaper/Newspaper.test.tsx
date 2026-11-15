import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'cheerio';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { issueSchema, POST_URL_RE, type Issue as IssueDoc } from '@/pipeline/schema';

import referenceJson from './__fixtures__/reference-issue.json';
import sampleJson from './__fixtures__/sample-issue.json';
import { sparseIssues } from './__fixtures__/sparse-issue';
import { Newspaper, type NewspaperTheme } from './Newspaper';

const sample = issueSchema.parse(sampleJson);
const reference = issueSchema.parse(referenceJson);

function render(issue: IssueDoc, theme?: NewspaperTheme) {
  return load(renderToStaticMarkup(<Newspaper issue={issue} theme={theme} />));
}

function postUrls(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => postUrls(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'postUrl' && typeof v === 'string') out.add(v);
      else postUrls(v, out);
    }
  }
  return out;
}

const UNIT_SELECTORS = [
  '.lead',
  '.fact',
  '.ear',
  '.inverse',
  'article',
  '.story',
  '.brief li',
  '.quote',
  '.curio li',
  '.ev',
];

const allFixtures: [string, IssueDoc][] = [
  ['sample', sample],
  ['reference', reference],
  ...Object.entries(sparseIssues),
];

describe('fixtures', () => {
  it.each(allFixtures)('%s passes issueSchema', (_, issue) => {
    expect(issueSchema.safeParse(issue).success).toBe(true);
  });
});

describe('links invariant', () => {
  it.each(allFixtures)('%s: every unit links its posts, nothing lost or invented', (_, issue) => {
    const $ = render(issue);
    for (const selector of UNIT_SELECTORS) {
      $(selector).each((_, el) => {
        expect($(el).find('.byline a').length, `${selector}: ${$(el).text()}`).toBeGreaterThan(0);
      });
    }
    const hrefs = new Set<string>();
    $('a').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      expect(href).toMatch(POST_URL_RE);
      expect($(a).attr('target')).toBe('_blank');
      expect($(a).attr('rel')).toBe('noopener noreferrer');
      hrefs.add(href);
    });
    // Facts beyond the first three are intentionally not rendered.
    const shown = { ...issue, lead: { ...issue.lead, facts: issue.lead.facts.slice(0, 3) } };
    expect([...hrefs].sort()).toEqual([...postUrls(shown)].sort());
  });
});

describe('sample issue', () => {
  const $ = render(sample);

  it('renders the masthead from code', () => {
    expect($('.strip').text()).toBe('Выпуск № 1' + '20 сообщений · 4 канала');
    expect($('.dateline').text()).toBe('Новости за 15 ноября 2026');
    expect($('.end').text()).toBe('Подписка · № 1');
    expect($('.ears').hasClass('ears--single')).toBe(false);
    expect($('.ear')).toHaveLength(2);
  });

  it('renders slots present in the JSON and skips absent ones', () => {
    expect($('h1.hed').text()).toBe(sample.lead.headline);
    expect($('.facts')).toHaveLength(0);
    expect($('.lead p.drop')).toHaveLength(1);
    expect($('.front-section')).toHaveLength(1);
    expect($('.side-section .story')).toHaveLength(sample.sideSection?.stories.length ?? 0);
    expect($('.brief li')).toHaveLength(sample.briefs?.length ?? 0);
    expect($('.quote')).toHaveLength(0);
    expect($('.curio li')).toHaveLength(sample.curiosities?.length ?? 0);
    expect($('.events .ev')).toHaveLength(sample.events?.length ?? 0);
    expect($('.section')).toHaveLength(1);
  });

  it('formats the lead byline per channel', () => {
    expect($('.lead > .byline').text()).toBe('Топор Live: The Washington Post · Топор Live');
  });
});

describe('reference issue', () => {
  const $ = render(reference);

  it('splits the feature section 3 / rest', () => {
    expect($('.section--feature .feature-list .story')).toHaveLength(3);
    expect($('.section--feature .feature-extra .story')).toHaveLength(2);
    expect($('.section--feature h3.hed')).toHaveLength(1);
    expect($('.section--feature .story h4')).toHaveLength(5);
  });

  it('puts the top-ranked list before the extra stories in the DOM (phone reading order)', () => {
    const blocks = $('.section--feature')
      .children()
      .map((_, el) => $(el).attr('class'))
      .get();
    expect(blocks).toEqual(['sec', 'section__article', 'feature-list', 'feature-extra']);
    expect($('.section--feature .story h4').first().text()).toBe('Кошелёк для агентов');
  });

  it('renders grid sections, events, facts and the side column', () => {
    expect($('.section--grid')).toHaveLength(2);
    expect($('.section--grid.section--cols-3')).toHaveLength(2);
    expect($('.events .ev')).toHaveLength(8);
    expect($('.facts.facts--3 .fact')).toHaveLength(3);
    expect($('.front').hasClass('front--solo')).toBe(false);
  });

  it('keeps DOM order of main and side columns', () => {
    const main = $('.main-col')
      .children()
      .map((_, el) => $(el).attr('class'))
      .get();
    expect(main).toEqual(['lead', 'front-section', 'curio']);
    const side = $('.side-col')
      .children()
      .map((_, el) => $(el).attr('class'))
      .get();
    expect(side).toEqual(['brief', 'quote', 'side-section']);
  });

  it('heading levels', () => {
    expect($('h1')).toHaveLength(1);
    expect($('.sec h2').first().text()).toBe('Авиация');
    expect($('.front-section h3.hed')).toHaveLength(1);
    expect($('.brief h2').text()).toBe('В двух словах');
    expect($('.curio h2').text()).toBe('Курьёзы');
  });

  it('lead byline groups labels under the channel', () => {
    expect($('.lead > .byline').text()).toBe(
      'КОНТЕКСТ: Белый дом · Кремль · Песков · Зеленский · Туск',
    );
  });
});

describe('thin issues', () => {
  it('minimal: no ears, no facts, solo front, no lower/events/side', () => {
    const $ = render(sparseIssues.minimal);
    expect($('.ears')).toHaveLength(0);
    expect($('.facts')).toHaveLength(0);
    expect($('.front').hasClass('front--solo')).toBe(true);
    expect($('.side-col, .lower, .events, .kick, .deck')).toHaveLength(0);
    expect($('.lead p.drop').text()).toBe('Ничего не произошло.');
  });

  it('facts modifiers and slice(0,3)', () => {
    expect(render(sparseIssues.oneFact)('.facts.facts--1 .fact')).toHaveLength(1);
    expect(render(sparseIssues.twoFacts)('.facts.facts--2 .fact')).toHaveLength(2);
    expect(render(sparseIssues.fourFacts)('.facts.facts--3 .fact')).toHaveLength(3);
  });

  it('only weather → single ear', () => {
    const $ = render(sparseIssues.onlyWeather);
    expect($('.ears.ears--single .ear--weather')).toHaveLength(1);
  });

  it('feature without article falls back to grid', () => {
    const $ = render(sparseIssues.featureWithoutArticle);
    expect($('.section--feature')).toHaveLength(0);
    expect($('.section--grid.section--cols-2 .story h3')).toHaveLength(2);
  });

  it('empty section is skipped entirely', () => {
    const $ = render(sparseIssues.emptySection);
    expect($('.section, .lower, ul:empty')).toHaveLength(0);
    expect($.html()).not.toContain('Пустая');
  });

  it('grid section with article renders it wide above the stories', () => {
    const $ = render(sparseIssues.gridWithArticle);
    expect($('.section--grid > .section__article--wide h3.hed').text()).toBe('Статья в сетке');
    expect($('.section--grid .story h4')).toHaveLength(1);
  });

  it('multi-channel byline rules', () => {
    const $ = render(sparseIssues.multiChannel);
    expect($('.lead > .byline').text()).toBe(
      'КОНТЕКСТ: Белый дом · Кремль; Топор Live: Al Jazeera · 2; XOR: 1 · 2',
    );
    expect($('.brief li b')).toHaveLength(0);
  });
});

describe('safety and theme', () => {
  it('escapes hostile text', () => {
    const hostile: IssueDoc = {
      ...sparseIssues.minimal,
      lead: {
        ...sparseIssues.minimal.lead,
        headline: '<img src=x onerror=alert(1)>',
        paragraphs: ['<script>alert(1)</script>'],
      },
    };
    const $ = render(hostile);
    expect($('img, script')).toHaveLength(0);
    expect($('h1').text()).toBe('<img src=x onerror=alert(1)>');
  });

  it('sets data-theme only when forced', () => {
    expect(render(sample)('.np').attr('data-theme')).toBeUndefined();
    expect(render(sample, 'dark')('.np').attr('data-theme')).toBe('dark');
  });

  it("no 'use client' or dangerouslySetInnerHTML in newspaper/issue sources", () => {
    const roots = [join(process.cwd(), 'src/newspaper'), join(process.cwd(), 'src/app/issue')];
    const banned = ['use ' + 'client', 'dangerously' + 'SetInnerHTML'];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const files = roots
      .flatMap(walk)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const word of banned) expect(source, file).not.toContain(word);
    }
  });
});
