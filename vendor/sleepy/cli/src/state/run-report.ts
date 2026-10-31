import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readQueue, type QueueItem } from './queue.js';
import { sleepyPaths } from '../paths.js';

export const queueIdentity = (item: Pick<QueueItem, 'number' | 'artifact'>) => `${item.number}:${JSON.stringify(item.artifact)}`;

/** Call and finish while holding the supervisor's project lock. */
export async function beginRunReport(root: string, runId: string): Promise<() => Promise<void>> {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId)) throw new Error('Invalid run ID');
  const before = (await readQueue(root)).map(queueIdentity);
  const targetBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  const dir = path.join(sleepyPaths(root).root, 'runs');
  const file = path.join(dir, runId + '.json');
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ before, targetBranch }), { mode: 0o600, flag: 'wx' });
  return async () => {
    const baseline = new Set(before);
    const produced = (await readQueue(root)).map(queueIdentity).filter(id => !baseline.has(id));
    await writeFile(file + '.tmp', JSON.stringify({ before, targetBranch, produced }), { mode: 0o600 });
    await rename(file + '.tmp', file);
  };
}
