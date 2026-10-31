import { Command } from 'commander';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readQueue } from '../state/queue.js';
import { sleepyPaths } from '../paths.js';

const execFile = promisify(execFileCb);

export type DiscardResult =
  | { status: 'discarded' }
  | { status: 'not-found' }
  | { status: 'invalid-branch'; branch: string }
  | { status: 'invalid-path'; targetPath: string };

// Hard invariants (docs/safety.md): sleepy only deletes branches it
// created, and only unlinks file artifacts that live under the project
// root. Both guards defend against a worker-written queue row pointing
// `sleepy discard` at arbitrary branches or files on the user's machine.
const SLEEPY_BRANCH_PREFIX = 'sleepy/';

function isPathInsideRoot(root: string, absTarget: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(absTarget);
  const rel = path.relative(normalizedRoot, normalizedTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

async function removeQueueRow(projectRoot: string, itemNumber: number): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  const raw = await readFile(paths.queueMd, 'utf8');
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter((line) => {
    if (!line.startsWith('|')) return true;
    if (line.includes('---')) return true;
    if (line.includes('| #') && line.includes('| Type')) return true;
    const cells = line.split('|').map((c) => c.trim());
    return cells[1] !== String(itemNumber);
  });
  await writeFile(paths.queueMd, kept.join('\n'), 'utf8');
}

export async function discardQueueItem(
  repoRoot: string,
  itemNumber: number,
): Promise<DiscardResult> {
  const items = await readQueue(repoRoot);
  const item = items.find((i) => i.number === itemNumber);
  if (!item) return { status: 'not-found' };

  if (item.artifact.kind === 'branch') {
    const branch = item.artifact.name;
    if (!branch.startsWith(SLEEPY_BRANCH_PREFIX)) {
      return { status: 'invalid-branch', branch };
    }
    try {
      await execFile('git', ['branch', '-D', branch], { cwd: repoRoot });
    } catch {
      // Branch may already be gone
    }
  } else {
    const absPath = path.isAbsolute(item.artifact.path)
      ? item.artifact.path
      : path.join(repoRoot, item.artifact.path);
    if (!isPathInsideRoot(repoRoot, absPath)) {
      return { status: 'invalid-path', targetPath: absPath };
    }
    try {
      await unlink(absPath);
    } catch {
      // ENOENT is fine
    }
  }

  await removeQueueRow(repoRoot, itemNumber);
  return { status: 'discarded' };
}

export function discardCommand(): Command {
  return new Command('discard')
    .description('remove a queue item (delete branch or file artifact) and drop the row')
    .argument('<number>', 'queue item number')
    .action(async (numStr: string) => {
      const n = Number(numStr);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`invalid queue number: ${numStr}`);
        process.exit(2);
      }
      const result = await discardQueueItem(process.cwd(), n);
      switch (result.status) {
        case 'not-found':
          console.error(`sleepy: no queue item #${n}`);
          process.exit(1);
          return;
        case 'invalid-branch':
          console.error(
            `sleepy: refusing to delete ${result.branch} — sleepy only discards branches under ${SLEEPY_BRANCH_PREFIX}`,
          );
          process.exit(1);
          return;
        case 'invalid-path':
          console.error(
            `sleepy: refusing to unlink ${result.targetPath} — target is outside the project root`,
          );
          process.exit(1);
          return;
        case 'discarded':
          console.log(`sleepy: discarded queue item #${n}`);
          return;
      }
    });
}
