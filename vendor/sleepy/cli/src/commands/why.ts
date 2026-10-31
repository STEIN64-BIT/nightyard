import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readQueue } from '../state/queue.js';

const execFile = promisify(execFileCb);

export type WhyResult =
  | { status: 'ok'; content: string }
  | { status: 'not-found' }
  | { status: 'missing-artifact' };

export async function whyQueueItem(
  repoRoot: string,
  itemNumber: number,
): Promise<WhyResult> {
  const items = await readQueue(repoRoot);
  const item = items.find((i) => i.number === itemNumber);
  if (!item) return { status: 'not-found' };

  if (item.artifact.kind === 'branch') {
    try {
      const { stdout } = await execFile(
        'git',
        ['show', `${item.artifact.name}:SLEEPY_ARTIFACT.md`],
        { cwd: repoRoot },
      );
      return { status: 'ok', content: stdout };
    } catch {
      return { status: 'missing-artifact' };
    }
  }

  const absPath = path.isAbsolute(item.artifact.path)
    ? item.artifact.path
    : path.join(repoRoot, item.artifact.path);
  try {
    const content = await readFile(absPath, 'utf8');
    return { status: 'ok', content };
  } catch {
    return { status: 'missing-artifact' };
  }
}

export function whyCommand(): Command {
  return new Command('why')
    .description('show the reasoning / SLEEPY_ARTIFACT.md for a queue item')
    .argument('<number>', 'queue item number')
    .action(async (numStr: string) => {
      const n = Number(numStr);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`invalid queue number: ${numStr}`);
        process.exit(2);
      }
      const result = await whyQueueItem(process.cwd(), n);
      if (result.status === 'not-found') {
        console.error(`sleepy: no queue item #${n}`);
        process.exit(1);
      }
      if (result.status === 'missing-artifact') {
        console.error(`sleepy: queue item #${n} has no artifact on disk`);
        process.exit(1);
      }
      process.stdout.write(result.content);
    });
}
