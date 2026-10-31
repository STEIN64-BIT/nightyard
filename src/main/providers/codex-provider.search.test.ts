import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readdirSync: vi.fn(() => []),
  promises: { readFile: vi.fn(), readdir: vi.fn() },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home' }));

vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('../codex-config', () => ({ getCodexConfig: async () => ({}) }));
vi.mock('../codex-hooks', () => ({
  installCodexHooks: () => {}, validateCodexHooks: () => ({}), cleanupCodexHooks: () => {}, SESSION_ID_VAR: 'CODEX_SESSION_ID',
}));
vi.mock('../config-watcher', () => ({ startConfigWatcher: () => {}, stopConfigWatcher: () => {} }));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true }));
vi.mock('../codex-homes', () => ({
  DEFAULT_CODEX_ACCOUNT: 'default',
  codexHomeDir: () => '/mock/home/.codex',
  resolveCodexHome: () => '/mock/home/.codex',
  listCodexHomes: vi.fn(() => ['/mock/home/.codex']),
}));

import * as fs from 'fs';
import * as path from 'path';
import { CodexProvider } from './codex-provider';
import { listCodexHomes } from '../codex-homes';

const mockReadFile = vi.mocked(fs.promises.readFile);
const mockReaddir = vi.mocked(fs.promises.readdir);

const UUID = '019d3512-caf9-7b50-8d2b-ccccdcf8ff14';

function dir(name: string) { return { name, isDirectory: () => true } as fs.Dirent; }
function file(name: string) { return { name, isDirectory: () => false } as fs.Dirent; }

function makeJsonl(entries: object[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

beforeEach(() => { vi.clearAllMocks(); });

describe('CodexProvider.discoverTranscripts()', () => {
  it('walks YYYY/MM/DD and parses cliSessionId from filename suffix', async () => {
    // Walker uses readdir withFileTypes at each level; depth 3 enumerates files.
    mockReaddir
      .mockResolvedValueOnce([dir('2026')] as any)
      .mockResolvedValueOnce([dir('03')] as any)
      .mockResolvedValueOnce([dir('28')] as any)
      .mockResolvedValueOnce([
        file(`rollout-2026-03-28T18-31-57-${UUID}.jsonl`),
        file('README.md'),
      ] as any);

    const out = await new CodexProvider().discoverTranscripts();
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(UUID);
    expect(out[0].transcriptPath).toContain(`rollout-2026-03-28T18-31-57-${UUID}.jsonl`);
  });

  it('returns [] when root is missing', async () => {
    mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await new CodexProvider().discoverTranscripts()).toEqual([]);
  });
});

describe('CodexProvider.indexTranscript()', () => {
  it('pulls cwd from session_meta and user text from response_item with role=user', async () => {
    const jsonl = makeJsonl([
      { type: 'session_meta', payload: { cwd: '/Users/me/repo', id: UUID } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'fix the bug' },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: 'never indexed' },
      ] } },
    ]);
    mockReadFile.mockResolvedValueOnce(jsonl as any);
    const r = await new CodexProvider().indexTranscript('/p');
    expect(r.cwd).toBe('/Users/me/repo');
    expect(r.text).toContain('fix the bug');
    expect(r.text).not.toContain('never indexed');
  });

  it('concatenates multiple input_text blocks', async () => {
    const jsonl = makeJsonl([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'part one' },
        { type: 'input_text', text: 'part two' },
      ] } },
    ]);
    mockReadFile.mockResolvedValueOnce(jsonl as any);
    const r = await new CodexProvider().indexTranscript('/p');
    expect(r.text).toContain('part one');
    expect(r.text).toContain('part two');
  });
});

describe('multiple homes', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const HOME_A = '/mock/home/.codex';
  const HOME_B = '/mock/home/.codex-personal';
  const fileA = `rollout-2026-09-10T10-00-00-${UUID_A}.jsonl`;
  const fileB = `rollout-2026-09-10T11-00-00-${UUID_B}.jsonl`;

  function tree(): Record<string, fs.Dirent[]> {
    const t: Record<string, fs.Dirent[]> = {};
    for (const [home, f] of [[HOME_A, fileA], [HOME_B, fileB]] as const) {
      t[path.join(home, 'sessions')] = [dir('2026')];
      t[path.join(home, 'sessions', '2026')] = [dir('09')];
      t[path.join(home, 'sessions', '2026', '09')] = [dir('10')];
      t[path.join(home, 'sessions', '2026', '09', '10')] = [file(f)];
    }
    return t;
  }

  beforeEach(() => {
    vi.mocked(listCodexHomes).mockReturnValue([HOME_A, HOME_B]);
    const t = tree();
    mockReaddir.mockImplementation((async (p: any) => {
      const entries = t[String(p)];
      if (!entries) throw new Error('ENOENT');
      return entries;
    }) as any);
    vi.mocked(fs.readdirSync).mockImplementation(((p: any) => {
      const entries = t[String(p)];
      if (!entries) throw new Error('ENOENT');
      return entries.map(d => d.name);
    }) as any);
  });

  it('discoverTranscripts walks the sessions dir of every home', async () => {
    const found = await new CodexProvider().discoverTranscripts();
    expect(found.map(t => t.cliSessionId).sort()).toEqual([UUID_A, UUID_B]);
    expect(found.find(t => t.cliSessionId === UUID_B)!.transcriptPath.startsWith(HOME_B + '/')).toBe(true);
  });

  it('getTranscriptPath finds a session that only exists in the second home', () => {
    expect(new CodexProvider().getTranscriptPath(UUID_B, '/proj')).toBe(
      path.join(HOME_B, 'sessions', '2026', '09', '10', fileB),
    );
    expect(new CodexProvider().getTranscriptPath(UUID_A, '/proj')).toBe(
      path.join(HOME_A, 'sessions', '2026', '09', '10', fileA),
    );
  });
});
