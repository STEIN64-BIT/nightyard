import { Command } from 'commander';
import { access, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sleepyPaths } from '../paths.js';

export async function writeStopFlag(projectRoot: string): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  await mkdir(path.dirname(paths.stopFlag), { recursive: true });
  await writeFile(paths.stopFlag, new Date().toISOString() + '\n', 'utf8');
}

export async function isStopFlagPresent(projectRoot: string): Promise<boolean> {
  const paths = sleepyPaths(projectRoot);
  try {
    await access(paths.stopFlag);
    return true;
  } catch {
    return false;
  }
}

export function stopCommand(): Command {
  return new Command('stop')
    .description('request a graceful stop — the supervisor will wind down on its next iteration')
    .action(async () => {
      await writeStopFlag(process.cwd());
      console.log('sleepy: STOP flag written; supervisor will stop on its next iteration.');
    });
}
