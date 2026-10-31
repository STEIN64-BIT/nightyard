import { describe, it, expect } from 'vitest';
import { codexSessionMenuEntries } from './codex-account-menu';
import type { CodexAccount } from '../../shared/types';

const account = (id: string, label = id): CodexAccount => ({ id, label, home: `/home/u/.codex-${id}` });

describe('codexSessionMenuEntries', () => {
  it('keeps the single generic item when only the default login exists', () => {
    expect(codexSessionMenuEntries('Codex CLI', [account('default')])).toEqual([
      { text: 'New Codex CLI Session', account: undefined, title: undefined },
    ]);
  });

  it('keeps the single generic item when accounts could not be listed', () => {
    expect(codexSessionMenuEntries('Codex CLI', [])).toEqual([
      { text: 'New Codex CLI Session', account: undefined, title: undefined },
    ]);
  });

  it('offers one item per login once there is a choice, naming the account and carrying its id', () => {
    const entries = codexSessionMenuEntries('Codex CLI', [
      account('default', 'default (work@example.com)'),
      account('personal', 'personal (me@example.org)'),
    ]);
    expect(entries).toEqual([
      { text: 'New Codex CLI Session · default', account: 'default', title: 'default (work@example.com)' },
      { text: 'New Codex CLI Session · personal', account: 'personal', title: 'personal (me@example.org)' },
    ]);
  });
});
