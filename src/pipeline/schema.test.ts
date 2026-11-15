import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import draft from './__fixtures__/issue-draft.json';
import { issueDraftSchema } from './schema';

const walk = (node: unknown, visit: (key: string, value: unknown) => void): void => {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walk(value, visit);
    }
  }
};

describe('issueDraftSchema', () => {
  it('accepts the synthetic draft fixture', () => {
    expect(issueDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('has no URL fields, bounds, or real unions in the LLM schema', () => {
    const jsonSchema = z.toJSONSchema(issueDraftSchema);
    const keys = new Set<string>();
    walk(jsonSchema, (key, value) => {
      keys.add(key);
      if (key === 'anyOf') {
        // Only `T | null` is allowed (Gemini handles it as nullable).
        expect(Array.isArray(value) && value.length === 2).toBe(true);
        expect(value).toContainEqual({ type: 'null' });
      }
    });
    for (const forbidden of ['minItems', 'maxItems', 'minLength', 'maxLength', 'oneOf', 'format']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const text = JSON.stringify(jsonSchema).toLowerCase();
    expect(text).not.toContain('url');
  });
});
