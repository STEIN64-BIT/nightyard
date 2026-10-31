import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface FindOpts {
  projectsRoot: string;
  cutoffMs: number;
  sessionId?: string;
}

/**
 * Returns the absolute path to the newest *.jsonl file under projectsRoot
 * whose mtime is >= cutoffMs, or null if none match.
 *
 * The cutoff lets the supervisor distinguish "session file from this
 * iteration" from "session file from some previous run" — it stores
 * Date.now() right before launching Claude and passes it here afterwards.
 */
export async function findNewestSessionFile(opts: FindOpts): Promise<string | null> {
  let projectDirs: string[];
  try {
    const entries = await readdir(opts.projectsRoot, { withFileTypes: true });
    projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(opts.projectsRoot, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let best: { file: string; mtimeMs: number } | null = null;

  for (const dir of projectDirs) {
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      if (opts.sessionId && name !== `${opts.sessionId}.jsonl`) continue;
      const file = path.join(dir, name);
      let s;
      try {
        s = await stat(file);
      } catch {
        continue;
      }
      if (s.mtimeMs < opts.cutoffMs) continue;
      if (best === null || s.mtimeMs > best.mtimeMs) {
        best = { file, mtimeMs: s.mtimeMs };
      }
    }
  }

  return best ? best.file : null;
}

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}
