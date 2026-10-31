import { execFile as execFileCb } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isPathDenied } from '../state/rules.js';

const execFile = promisify(execFileCb);

export async function listBranchChangedFiles(
  repoRoot: string,
  branch: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['diff', '--name-only', `HEAD..${branch}`],
      { cwd: repoRoot },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export type DiffCheckResult =
  | { status: 'ok'; changedFiles: string[] }
  | {
      status: 'denied';
      offendingFiles: string[];
      matchedPatterns: string[];
      changedFiles: string[];
    };

export interface DenyMatch {
  offendingFiles: string[];
  matchedPatterns: string[];
}

export function matchDenyPaths(files: string[], denyPaths: string[]): DenyMatch {
  const offendingFiles: string[] = [];
  const matchedPatterns = new Set<string>();

  for (const file of files) {
    let denied = false;
    for (const pattern of denyPaths) {
      if (isPathDenied(file, [pattern])) {
        denied = true;
        matchedPatterns.add(pattern);
      }
    }
    if (denied) offendingFiles.push(file);
  }

  return { offendingFiles, matchedPatterns: [...matchedPatterns] };
}

export async function checkBranchDiff(
  repoRoot: string,
  branch: string,
  denyPaths: string[],
): Promise<DiffCheckResult> {
  const changedFiles = await listBranchChangedFiles(repoRoot, branch);
  if (denyPaths.length === 0) {
    return { status: 'ok', changedFiles };
  }

  const { offendingFiles, matchedPatterns } = matchDenyPaths(changedFiles, denyPaths);
  if (offendingFiles.length > 0) {
    return {
      status: 'denied',
      offendingFiles,
      matchedPatterns,
      changedFiles,
    };
  }
  return { status: 'ok', changedFiles };
}

/**
 * What git can see of a working tree at one moment: HEAD, plus a
 * fingerprint (status code, size, mtime) for every dirty or untracked file
 * under `root`. `root` may be a subdirectory of the repo; paths are relative
 * to it and files outside it are not tracked. Gitignored files are invisible
 * to this check.
 */
export interface WorkingTreeSnapshot {
  head: string | null;
  prefix: string;
  files: Map<string, string>;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

// git reports paths relative to the repo root; callers work relative to `root`
function toRootRelative(prefix: string, repoPath: string): string {
  return path.posix.relative(prefix || '.', repoPath);
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((s) => s.length > 0);
}

async function fingerprint(absPath: string): Promise<string> {
  try {
    const s = await lstat(absPath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** Returns null when `root` is not inside a git repository. */
export async function snapshotWorkingTree(
  root: string,
): Promise<WorkingTreeSnapshot | null> {
  let prefix: string;
  let status: string;
  try {
    prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    status = await git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.',
    ]);
  } catch {
    return null;
  }

  let head: string | null = null;
  try {
    head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
  } catch {
    // unborn branch — no commits yet
  }

  const files = new Map<string, string>();
  for (const entry of splitNul(status)) {
    // porcelain v1: "XY <path>"
    const code = entry.slice(0, 2);
    const file = toRootRelative(prefix, entry.slice(3));
    files.set(file, `${code} ${await fingerprint(path.join(root, file))}`);
  }
  return { head, prefix, files };
}

/**
 * Files that changed between two snapshots of the same working tree:
 * newly dirty, modified again, reverted/stashed, or moved by a commit or
 * checkout. Sorted, relative to the snapshot root.
 */
export async function listWorkingTreeChanges(
  root: string,
  before: WorkingTreeSnapshot,
  after: WorkingTreeSnapshot,
): Promise<string[]> {
  const changed = new Set<string>();
  for (const [file, fp] of after.files) {
    if (before.files.get(file) !== fp) changed.add(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.add(file);
  }

  if (before.head !== after.head && after.head !== null) {
    try {
      const stdout = before.head
        ? await git(root, ['diff', '--name-only', '-z', '--no-renames', before.head, after.head, '--', '.'])
        : await git(root, ['ls-tree', '-r', '--name-only', '-z', '--full-name', after.head]);
      for (const file of splitNul(stdout)) {
        changed.add(toRootRelative(after.prefix, file));
      }
    } catch {
      // best effort — working-tree changes above are still reported
    }
  }

  return [...changed].sort();
}
