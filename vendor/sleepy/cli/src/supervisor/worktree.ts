import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFile = promisify(execFileCb);

export interface CreateWorktreeOpts {
  repoRoot: string;
  branch: string;
}

export interface Worktree {
  branch: string;
  path: string;
}

/**
 * Create a fresh git worktree on a new branch off the repo's HEAD.
 * Worktree path lives under the OS tempdir so we don't pollute the repo.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<Worktree> {
  const slug = opts.branch.replace(/[\\/]/g, '-');
  const wtPath = await mkdtemp(path.join(os.tmpdir(), `${slug}-`));
  // git worktree add requires the target dir to not exist
  await rm(wtPath, { recursive: true, force: true });
  await execFile(
    'git',
    ['worktree', 'add', '-b', opts.branch, wtPath],
    { cwd: opts.repoRoot },
  );
  return { branch: opts.branch, path: wtPath };
}

export async function removeWorktree(
  repoRoot: string,
  wt: Worktree,
): Promise<void> {
  try {
    await execFile('git', ['worktree', 'remove', '--force', wt.path], {
      cwd: repoRoot,
    });
  } catch {
    await rm(wt.path, { recursive: true, force: true });
  }
}

export async function hasCommitsOnBranch(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFile(
      'git',
      ['rev-list', '--count', `HEAD..${branch}`],
      { cwd: repoRoot },
    );
    return Number(stdout.trim()) > 0;
  } catch {
    return false;
  }
}
