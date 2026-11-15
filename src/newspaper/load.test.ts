import { afterEach, describe, expect, it, vi } from 'vitest';

import sample from './__fixtures__/sample-issue.json';
import { createIssueLoader, resolveIssueView, type IssueRow } from './load';

const ID = '0b5c3a1e-7f0f-4b8e-9a51-1f0d2b3c4d5e';
const row = (over: Partial<IssueRow>): IssueRow => ({
  id: ID,
  status: 'ready',
  contentJson: sample,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('resolveIssueView', () => {
  it('missing row → not-found', () => {
    expect(resolveIssueView(undefined)).toEqual({ kind: 'not-found' });
  });

  it.each(['pending', 'collecting', 'digesting', 'composing'] as const)(
    '%s → building',
    (status) => {
      expect(resolveIssueView(row({ status }))).toEqual({ kind: 'building', status });
    },
  );

  it('failed → failed', () => {
    expect(resolveIssueView(row({ status: 'failed' }))).toEqual({ kind: 'failed' });
  });

  it('ready + valid → ready', () => {
    const view = resolveIssueView(row({}));
    expect(view.kind).toBe('ready');
  });

  it('ready + null → invalid', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveIssueView(row({ contentJson: null }))).toEqual({ kind: 'invalid' });
    expect(log).toHaveBeenCalledOnce();
  });

  it('schemaVersion 2 → invalid, logs id and paths but not content', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = resolveIssueView(row({ contentJson: { ...sample, schemaVersion: 2 } }));
    expect(view).toEqual({ kind: 'invalid' });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain(ID);
    expect(logged).toContain('schemaVersion');
    expect(logged).not.toContain(sample.lead.headline);
  });
});

describe('createIssueLoader', () => {
  it('invalid uuid → not-found without touching the DB', async () => {
    const fetchRow = vi.fn();
    const load = createIssueLoader(fetchRow);
    expect(await load('not-a-uuid')).toEqual({ kind: 'not-found' });
    expect(await load("1' or 1=1 --")).toEqual({ kind: 'not-found' });
    expect(fetchRow).not.toHaveBeenCalled();
  });

  it('valid uuid → fetches and resolves', async () => {
    const fetchRow = vi.fn(async () => row({ status: 'composing' }));
    const load = createIssueLoader(fetchRow);
    expect(await load(ID)).toEqual({ kind: 'building', status: 'composing' });
    expect(fetchRow).toHaveBeenCalledWith(ID);
  });
});
