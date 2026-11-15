import { issueSchema, type Issue as IssueDoc } from '@/pipeline/schema';

import referenceJson from './__fixtures__/reference-issue.json';
import sampleJson from './__fixtures__/sample-issue.json';
import { sparseIssues } from './__fixtures__/sparse-issue';

export const FIXTURE_NAMES = ['sample', 'reference', 'sparse'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function isFixtureName(value: unknown): value is FixtureName {
  return typeof value === 'string' && (FIXTURE_NAMES as readonly string[]).includes(value);
}

/** Dev preview fixtures, validated like real content_json. */
export function loadFixture(name: FixtureName): IssueDoc {
  switch (name) {
    case 'sample':
      return issueSchema.parse(sampleJson);
    case 'reference':
      return issueSchema.parse(referenceJson);
    case 'sparse':
      return issueSchema.parse(sparseIssues.multiChannel);
  }
}
