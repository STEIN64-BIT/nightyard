import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type CwdSafetyResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Exact paths sleepy hard-refuses. System roots, the user's home,
 * and the classic temp roots. Subdirectories of /tmp and /var are OK
 * because those are legitimately used for throwaway projects in tests.
 */
const HARD_REFUSALS_EXACT: ReadonlySet<string> = new Set([
  '/',
  '/tmp',
  '/var',
  '/usr',
  '/opt',
  '/etc',
  '/bin',
  '/sbin',
  '/root',
  '/System',
  '/Library',
]);

/**
 * Path prefixes sleepy refuses for any depth. These are system directories
 * where sleepy should never run — not even in a subdirectory.
 */
const HARD_REFUSALS_PREFIXES: readonly string[] = [
  '/System/',
  '/Library/',
  '/usr/',
  '/opt/',
  '/etc/',
  '/bin/',
  '/sbin/',
  '/root/',
];

export function checkCwdSafety(cwd: string): CwdSafetyResult {
  const normalized = path.resolve(cwd);
  const home = path.resolve(os.homedir());

  if (normalized === home) {
    return {
      ok: false,
      reason:
        `refusing to run in your home directory (${home}). sleepy is designed to run inside a specific project.\n` +
        `  Try one of:\n` +
        `    cd ~/Projects/<your-project> && sleepy init\n` +
        `    sleepy go "<describe the project you want to work on>"`,
    };
  }

  if (HARD_REFUSALS_EXACT.has(normalized)) {
    return {
      ok: false,
      reason: `refusing to run in ${normalized}. sleepy must run inside a project directory.`,
    };
  }

  for (const prefix of HARD_REFUSALS_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return {
        ok: false,
        reason: `refusing to run under ${prefix} (got ${normalized}). This is a system directory — sleepy needs a real project.`,
      };
    }
  }

  const warnings: string[] = [];
  if (!existsSync(path.join(normalized, '.git'))) {
    warnings.push('not a git repository');
  }
  return { ok: true, warnings };
}
