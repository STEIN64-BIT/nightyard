import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

import * as fs from 'fs';
import {
  DEFAULT_CODEX_ACCOUNT,
  codexHomeDir,
  listCodexAccounts,
  listCodexHomes,
  resolveCodexHome,
  readCodexLoginEmail,
} from './codex-homes';

const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

const HOME = '/mock/home';
const dirent = (name: string, kind: 'dir' | 'file' | 'link' = 'dir') => ({
  name,
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'link',
});

function jwtWithEmail(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email }), 'utf8').toString('base64url');
  return `hdr.${payload}.sig`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue([] as never);
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
});

describe('codexHomeDir', () => {
  it('maps the default account to ~/.codex', () => {
    expect(codexHomeDir()).toBe(path.join(HOME, '.codex'));
    expect(codexHomeDir(DEFAULT_CODEX_ACCOUNT)).toBe(path.join(HOME, '.codex'));
  });

  it('maps a named account to ~/.codex-<id>', () => {
    expect(codexHomeDir('personal')).toBe(path.join(HOME, '.codex-personal'));
  });

  it('rejects ids that could escape the naming scheme', () => {
    expect(() => codexHomeDir('../etc')).toThrow(/Invalid Codex account id/);
    expect(() => codexHomeDir('has space')).toThrow(/Invalid Codex account id/);
  });
});

describe('listCodexAccounts', () => {
  it('always returns the default account first, even when nothing else exists', () => {
    const accounts = listCodexAccounts();
    expect(accounts.map(a => a.id)).toEqual([DEFAULT_CODEX_ACCOUNT]);
    expect(accounts[0].home).toBe(path.join(HOME, '.codex'));
  });

  it('discovers ~/.codex-<id> directories that contain auth.json, sorted by id', () => {
    mockReaddirSync.mockReturnValue([
      dirent('.codex'),
      dirent('.codex-zed'),
      dirent('.codex-personal'),
      dirent('.codex-empty'), // no auth.json → skipped
      dirent('.codex-bad name'), // invalid id → skipped
      dirent('.codex-notes.txt', 'file'), // file → skipped
      dirent('Projects'),
    ] as never);
    mockExistsSync.mockImplementation((p) =>
      p === path.join(HOME, '.codex-zed', 'auth.json') || p === path.join(HOME, '.codex-personal', 'auth.json'));

    expect(listCodexAccounts().map(a => a.id)).toEqual([DEFAULT_CODEX_ACCOUNT, 'personal', 'zed']);
    expect(listCodexHomes()).toEqual([
      path.join(HOME, '.codex'),
      path.join(HOME, '.codex-personal'),
      path.join(HOME, '.codex-zed'),
    ]);
  });

  it('accepts a symlinked home directory', () => {
    mockReaddirSync.mockReturnValue([dirent('.codex-work', 'link')] as never);
    mockExistsSync.mockReturnValue(true);
    expect(listCodexAccounts().map(a => a.id)).toEqual([DEFAULT_CODEX_ACCOUNT, 'work']);
  });

  it('labels an account with the login email when auth.json carries a decodable id_token', () => {
    mockReaddirSync.mockReturnValue([dirent('.codex-personal')] as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      if (p === path.join(HOME, '.codex-personal', 'auth.json')) {
        return JSON.stringify({ tokens: { id_token: jwtWithEmail('me@example.com') } });
      }
      throw new Error('ENOENT');
    });
    const accounts = listCodexAccounts();
    expect(accounts.find(a => a.id === 'personal')!.label).toBe('personal (me@example.com)');
    // default home has no readable auth.json → bare id
    expect(accounts[0].label).toBe(DEFAULT_CODEX_ACCOUNT);
  });

  it('returns only the default account when the home directory cannot be listed', () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(listCodexAccounts().map(a => a.id)).toEqual([DEFAULT_CODEX_ACCOUNT]);
  });
});

describe('resolveCodexHome', () => {
  it('returns ~/.codex for the default account without checking auth.json', () => {
    expect(resolveCodexHome()).toBe(path.join(HOME, '.codex'));
    expect(resolveCodexHome(DEFAULT_CODEX_ACCOUNT)).toBe(path.join(HOME, '.codex'));
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('returns the account home when it is logged in', () => {
    mockExistsSync.mockImplementation((p) => p === path.join(HOME, '.codex-personal', 'auth.json'));
    expect(resolveCodexHome('personal')).toBe(path.join(HOME, '.codex-personal'));
  });

  it('throws a message with the login command when the account is not logged in', () => {
    expect(() => resolveCodexHome('personal')).toThrow(/not logged in/);
    expect(() => resolveCodexHome('personal')).toThrow(/CODEX_HOME=\/mock\/home\/\.codex-personal codex login/);
  });
});

describe('readCodexLoginEmail', () => {
  it('returns null for malformed or missing auth', () => {
    expect(readCodexLoginEmail('/mock/home/.codex')).toBeNull();
    mockReadFileSync.mockReturnValue('not json' as never);
    expect(readCodexLoginEmail('/mock/home/.codex')).toBeNull();
    mockReadFileSync.mockReturnValue(JSON.stringify({ tokens: { id_token: 'nodots' } }) as never);
    expect(readCodexLoginEmail('/mock/home/.codex')).toBeNull();
  });
});
