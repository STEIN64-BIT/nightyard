import { Command } from 'commander';
import { mkdir, lstat, symlink, unlink, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface LinkPluginOptions {
  src: string;
  dest: string;
  mode: 'symlink' | 'copy';
}

export interface LinkPluginResult {
  action: 'linked' | 'relinked' | 'copied' | 'recopied';
  dest: string;
}

async function statIfExists(target: string) {
  try {
    return await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function linkPlugin(opts: LinkPluginOptions): Promise<LinkPluginResult> {
  await mkdir(path.dirname(opts.dest), { recursive: true });

  const existing = await statIfExists(opts.dest);
  const replaced = existing !== null;

  if (existing) {
    if (existing.isSymbolicLink()) {
      await unlink(opts.dest);
    } else if (existing.isDirectory()) {
      await rm(opts.dest, { recursive: true, force: true });
    } else {
      throw new Error(
        `refusing to overwrite ${opts.dest}: not a symlink or directory`,
      );
    }
  }

  if (opts.mode === 'symlink') {
    await symlink(opts.src, opts.dest, 'dir');
    return { action: replaced ? 'relinked' : 'linked', dest: opts.dest };
  } else {
    await cp(opts.src, opts.dest, { recursive: true });
    return { action: replaced ? 'recopied' : 'copied', dest: opts.dest };
  }
}

/**
 * Resolve the monorepo's plugin directory from this CLI binary's location.
 * In dev the built dist sits at cli/dist/commands/link-plugin.js, so the
 * plugin is at ../../../plugin. In a published install the CLI and plugin
 * ship together via install.sh, which passes an explicit --src.
 */
export function defaultPluginSrc(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'plugin');
}

export function defaultPluginDest(): string {
  return path.join(os.homedir(), '.claude', 'plugins', 'sleepy');
}

export function linkPluginCommand(): Command {
  return new Command('link-plugin')
    .description('link (or copy) the sleepy plugin into ~/.claude/plugins/sleepy')
    .option('--copy', 'copy instead of symlink (for non-dev installs)')
    .option('--src <path>', 'plugin source directory (defaults to the monorepo plugin)')
    .option('--dest <path>', 'destination directory (defaults to ~/.claude/plugins/sleepy)')
    .action(async (opts: { copy?: boolean; src?: string; dest?: string }) => {
      const src = opts.src ?? defaultPluginSrc();
      const dest = opts.dest ?? defaultPluginDest();
      const mode: 'symlink' | 'copy' = opts.copy ? 'copy' : 'symlink';
      const result = await linkPlugin({ src, dest, mode });
      console.log(`sleepy plugin ${result.action} at ${result.dest}`);
    });
}
