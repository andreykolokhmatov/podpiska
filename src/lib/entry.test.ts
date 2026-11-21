import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isEntryPoint } from './entry';

describe('isEntryPoint', () => {
  const file = '/repo/src/setup/doctor.ts';
  const url = pathToFileURL(file).href;

  it('matches the started script, also via a relative path', () => {
    expect(isEntryPoint(url, file, 'linux')).toBe(true);
    expect(isEntryPoint(url, '/repo/src/setup/../setup/doctor.ts', 'linux')).toBe(true);
    expect(isEntryPoint(url, '/repo/src/deploy/release.ts', 'linux')).toBe(false);
    expect(isEntryPoint(url, undefined, 'linux')).toBe(false);
  });

  it('ignores case only on win32', () => {
    expect(isEntryPoint(url, '/REPO/src/setup/doctor.ts', 'win32')).toBe(true);
    expect(isEntryPoint(url, '/REPO/src/setup/doctor.ts', 'linux')).toBe(false);
  });

  it('rejects a non-file module url', () => {
    expect(isEntryPoint('https://example.com/doctor.ts', file, 'linux')).toBe(false);
  });
});
