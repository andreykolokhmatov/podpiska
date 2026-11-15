import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sampleJson from '@/newspaper/__fixtures__/sample-issue.json';
import { Newspaper } from '@/newspaper/Newspaper';
import { issueSchema } from '@/pipeline/schema';

import { MiniAppBridge } from './MiniAppBridge';

describe('MiniAppBridge', () => {
  it('adds nothing to the server-rendered newspaper', () => {
    const issue = issueSchema.parse(sampleJson);
    const plain = renderToStaticMarkup(<Newspaper issue={issue} />);
    const bridged = renderToStaticMarkup(
      <>
        <Newspaper issue={issue} />
        <MiniAppBridge />
      </>,
    );
    expect(bridged).toBe(plain);
  });
});
