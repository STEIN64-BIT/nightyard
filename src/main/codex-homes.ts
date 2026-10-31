import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CodexAccount } from '../shared/types';

/**
 * Codex "accounts" are CODEX_HOME directories. Codex CLI keeps one login per
 * home (auth.json), so a second login lives in a second home:
 *   default → ~/.codex
 *   <id>    → ~/.codex-<id>
 * Nothing is configured in Nightyard: create the directory, run
 * `CODEX_HOME=~/.codex-<id> codex login`, and the account shows up.
 */

export const DEFAULT_CODEX_ACCOUNT = 'default';

const HOME_PREFIX = '.codex-';
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function codexHomeDir(accountId?: string): string {
  const id = accountId || DEFAULT_CODEX_ACCOUNT;
  if (id === DEFAULT_CODEX_ACCOUNT) return path.join(os.homedir(), '.codex');
  if (!ACCOUNT_ID_RE.test(id)) throw new Error(`Invalid Codex account id: ${id}`);
  return path.join(os.homedir(), `${HOME_PREFIX}${id}`);
}

/** Default account first, then every ~/.codex-<id> holding an auth.json, sorted by id. */
export function listCodexAccounts(): CodexAccount[] {
  const home = os.homedir();
  const defaultHome = codexHomeDir();
  const accounts: CodexAccount[] = [
    { id: DEFAULT_CODEX_ACCOUNT, label: accountLabel(DEFAULT_CODEX_ACCOUNT, defaultHome), home: defaultHome },
  ];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return accounts;
  }

  const ids = entries
    .filter(e => e.name.startsWith(HOME_PREFIX) && (e.isDirectory() || e.isSymbolicLink()))
    .map(e => e.name.slice(HOME_PREFIX.length))
    .filter(id => ACCOUNT_ID_RE.test(id))
    .filter(id => fs.existsSync(path.join(home, `${HOME_PREFIX}${id}`, 'auth.json')))
    .sort();

  for (const id of ids) {
    const dir = path.join(home, `${HOME_PREFIX}${id}`);
    accounts.push({ id, label: accountLabel(id, dir), home: dir });
  }
  return accounts;
}

export function listCodexHomes(): string[] {
  return listCodexAccounts().map(a => a.home);
}

/**
 * Home for a session's account. The default home is returned as-is (Codex
 * itself reports "not logged in" there); a named account must be logged in,
 * otherwise we refuse rather than silently running under the default login.
 */
export function resolveCodexHome(accountId?: string): string {
  const id = accountId || DEFAULT_CODEX_ACCOUNT;
  const dir = codexHomeDir(id);
  if (id !== DEFAULT_CODEX_ACCOUNT && !fs.existsSync(path.join(dir, 'auth.json'))) {
    throw new Error(
      `Codex account "${id}" is not logged in (no auth.json in ${dir}). Run: CODEX_HOME=${dir} codex login`,
    );
  }
  return dir;
}

/** Email claim from the ChatGPT id_token in <home>/auth.json, or null. Best effort, never throws. */
export function readCodexLoginEmail(home: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const idToken: unknown = raw?.tokens?.id_token;
    if (typeof idToken !== 'string') return null;
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims?.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

function accountLabel(id: string, home: string): string {
  const email = readCodexLoginEmail(home);
  return email ? `${id} (${email})` : id;
}
