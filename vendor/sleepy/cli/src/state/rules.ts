import { readFile } from 'node:fs/promises';
import { sleepyPaths } from '../paths.js';

export interface SleepyRules {
  denyPaths: string[];
  rawContent: string;
}

/**
 * Parse a "## Do not touch" section out of SLEEPY_RULES.md.
 *
 * - Lines inside `<!-- ... -->` HTML comments are ignored (examples).
 * - A section runs from `## <heading>` until the next `## ` line or EOF.
 * - Inside the Do-not-touch section, any `- <path>` bullet is added to denyPaths.
 * - Indentation is tolerated.
 */
function parseDenyPaths(content: string): string[] {
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split(/\r?\n/);

  let inSection = false;
  const deny: string[] = [];
  for (const line of lines) {
    const headingMatch = /^\s*##\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      inSection = /do\s*not\s*touch/i.test(headingMatch[1]!);
      continue;
    }
    if (!inSection) continue;
    const bulletMatch = /^\s*-\s+(\S.*?)\s*$/.exec(line);
    if (bulletMatch) {
      deny.push(bulletMatch[1]!);
    }
  }
  return deny;
}

export async function readRules(projectRoot: string): Promise<SleepyRules> {
  const paths = sleepyPaths(projectRoot);
  let raw: string;
  try {
    raw = await readFile(paths.rulesMd, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { denyPaths: [], rawContent: '' };
    }
    throw err;
  }
  return { denyPaths: parseDenyPaths(raw), rawContent: raw };
}

/**
 * Returns true if `filePath` matches any of the deny patterns.
 * Supported patterns:
 *   - "prefix/" — directory prefix match (any file under that dir)
 *   - "glob-*.ext" — simple shell-style glob on the filename
 *   - "exact/path.ext" — exact path match
 */
export function isPathDenied(filePath: string, denyPaths: string[]): boolean {
  for (const pattern of denyPaths) {
    if (pattern.endsWith('/')) {
      if (filePath === pattern.slice(0, -1)) continue;
      if (filePath.startsWith(pattern)) return true;
      continue;
    }
    if (pattern.includes('*')) {
      const re = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      if (re.test(filePath)) return true;
      continue;
    }
    if (filePath === pattern) return true;
  }
  return false;
}
