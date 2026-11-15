import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('dev mock isolation', () => {
  it('only devMock.ts references the mock module, behind a NODE_ENV=development guard', () => {
    const importers = sourceFiles(SRC)
      .filter((file) =>
        /['"]\.\/dev-mock['"]|['"]@\/miniapp\/client\/dev-mock['"]/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(SRC, file));
    expect(importers).toEqual([join('miniapp', 'client', 'devMock.ts')]);

    const loader = readFileSync(join(SRC, 'miniapp', 'client', 'devMock.ts'), 'utf8');
    expect(loader).toMatch(
      /process\.env\.NODE_ENV === 'development' \? \(\) => import\('\.\/dev-mock'\) : null/,
    );
  });
});
