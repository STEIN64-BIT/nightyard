import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readQueue } from '../state/queue.js';
import { sleepyPaths } from '../paths.js';

const execFile = promisify(execFileCb);

export type ApplyResult =
  | { status: 'merged'; branch: string }
  | { status: 'not-found' }
  | { status: 'not-a-branch' }
  | { status: 'invalid-branch'; branch: string }
  | { status: 'conflict'; branch: string };

// Hard invariant (documented in docs/safety.md): sleepy only touches
// branches it created. Enforced here so a worker-written queue row can't
// trick `sleepy apply` into merging an unrelated local branch.
const SLEEPY_BRANCH_PREFIX = 'sleepy/';

export async function markApproved(projectRoot: string, itemNumber: number): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  const raw = await readFile(paths.queueMd, 'utf8');
  const lines = raw.split(/\r?\n/);
  const updated = lines.map((line) => {
    if (!line.startsWith('|')) return line;
    if (line.includes('---')) return line;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] !== String(itemNumber)) return line;
    // Preserve original line structure — just swap [ ] for [x] on the matched row
    return line.replace(/\[\s?\]/, '[x]');
  });
  await writeFile(paths.queueMd, updated.join('\n'), 'utf8');
}

export async function applyQueueItem(
  repoRoot: string,
  itemNumber: number,
): Promise<ApplyResult> {
  const items = await readQueue(repoRoot);
  const item = items.find((i) => i.number === itemNumber);
  if (!item) return { status: 'not-found' };
  if (item.artifact.kind !== 'branch') return { status: 'not-a-branch' };

  const branch = item.artifact.name;
  if (!branch.startsWith(SLEEPY_BRANCH_PREFIX)) {
    return { status: 'invalid-branch', branch };
  }

  try {
    await execFile('git', ['merge', '--no-ff', '-m', `sleepy: merge ${branch}`, branch], {
      cwd: repoRoot,
    });
  } catch {
    try {
      await execFile('git', ['merge', '--abort'], { cwd: repoRoot });
    } catch {
      // if abort fails, leave as-is
    }
    return { status: 'conflict', branch };
  }

  await markApproved(repoRoot, itemNumber);
  return { status: 'merged', branch };
}

export function applyCommand(): Command {
  return new Command('apply')
    .description('merge a queue item (by number) into the current branch')
    .argument('<number>', 'queue item number')
    .action(async (numStr: string) => {
      const n = Number(numStr);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`invalid queue number: ${numStr}`);
        process.exit(2);
      }
      const result = await applyQueueItem(process.cwd(), n);
      switch (result.status) {
        case 'merged':
          console.log(`sleepy: merged ${result.branch} into current branch`);
          return;
        case 'not-found':
          console.error(`sleepy: no queue item #${n}`);
          process.exit(1);
          return;
        case 'not-a-branch':
          console.error(`sleepy: queue item #${n} is not a branch artifact`);
          process.exit(1);
          return;
        case 'invalid-branch':
          console.error(
            `sleepy: refusing to merge ${result.branch} — sleepy only merges branches under ${SLEEPY_BRANCH_PREFIX}`,
          );
          process.exit(1);
          return;
        case 'conflict':
          console.error(
            `sleepy: merge conflict on ${result.branch}. Your working tree has been reset. Resolve manually or discard.`,
          );
          process.exit(1);
          return;
      }
    });
}
