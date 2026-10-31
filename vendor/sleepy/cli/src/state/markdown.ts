import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sleepyPaths } from '../paths.js';

export type MarkdownName = 'state' | 'backlog' | 'queue' | 'memory' | 'rules';

function resolveMdPath(projectRoot: string, name: MarkdownName): string {
  const p = sleepyPaths(projectRoot);
  switch (name) {
    case 'state':
      return p.stateMd;
    case 'backlog':
      return p.backlogMd;
    case 'queue':
      return p.queueMd;
    case 'memory':
      return p.memoryMd;
    case 'rules':
      return p.rulesMd;
  }
}

export async function readMarkdown(
  projectRoot: string,
  name: MarkdownName,
): Promise<string | null> {
  const target = resolveMdPath(projectRoot, name);
  try {
    return await readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeMarkdown(
  projectRoot: string,
  name: MarkdownName,
  content: string,
): Promise<void> {
  const target = resolveMdPath(projectRoot, name);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}
