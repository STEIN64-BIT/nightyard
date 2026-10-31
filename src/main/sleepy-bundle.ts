import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';

// Sleepy ships inside Nightyard: scripts/build-sleepy.mjs bundles vendor/sleepy
// into dist/sleepy/, and electron-builder copies that to Resources/sleepy/.
// Preferences → Sleepy → "Own Sleepy CLI" can still point at a checkout.

export function bundledSleepyDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sleepy')
    : path.join(app.getAppPath(), 'dist', 'sleepy');
}

export function bundledSleepyBin(): string {
  return path.join(bundledSleepyDir(), 'cli', 'bin', 'sleepy.mjs');
}

/** The user's own sleepy.mjs when one is set, otherwise the built-in one. */
export function resolveSleepyBin(configured: string | undefined | null): string {
  const own = configured?.trim();
  return own ? own : bundledSleepyBin();
}

/**
 * Run Sleepy with Nightyard's own Node (Electron in Node mode), so it works
 * without a separate Node.js install.
 */
export function sleepyNodeCommand(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function sleepyPluginDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'plugins', 'sleepy');
}

/**
 * Sleepy's Claude workers read their skills from ~/.claude/plugins/sleepy.
 * Link it once from the Sleepy that is about to run, unless one is already
 * there (existsSync follows the link, so a dangling link counts as missing
 * and is replaced). Returns a line for the Sleepy output, or null.
 */
export function ensureSleepyPlugin(sleepyBin: string, env: NodeJS.ProcessEnv, home: string = os.homedir()): string | null {
  if (fs.existsSync(sleepyPluginDir(home))) return null;
  const { command, env: nodeEnv } = sleepyNodeCommand();
  const res = spawnSync(command, [sleepyBin, 'link-plugin'], {
    env: { ...env, ...nodeEnv },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  if (res.status === 0) return `[nightyard] ${res.stdout.trim() || 'Sleepy plugin linked'}\n`;
  const why = (res.stderr || res.error?.message || `exit ${res.status}`).trim();
  return `[nightyard] Could not link the Sleepy plugin into ~/.claude/plugins/sleepy: ${why}\n`;
}
