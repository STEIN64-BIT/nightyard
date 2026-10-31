import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const electron = vi.hoisted(() => ({ app: { isPackaged: false, getAppPath: () => '/repo' } }));
vi.mock('electron', () => electron);

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

import {
  bundledSleepyBin,
  resolveSleepyBin,
  sleepyNodeCommand,
  ensureSleepyPlugin,
  sleepyPluginDir,
} from './sleepy-bundle';

describe('sleepy-bundle', () => {
  const realResourcesPath = process.resourcesPath;
  let home: string;

  beforeEach(() => {
    electron.app.isPackaged = false;
    spawnSyncMock.mockReset();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nightyard-sleepy-home-'));
  });
  afterEach(() => {
    (process as { resourcesPath?: string }).resourcesPath = realResourcesPath;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('uses dist/sleepy in a dev checkout', () => {
    expect(bundledSleepyBin()).toBe(path.join('/repo', 'dist', 'sleepy', 'cli', 'bin', 'sleepy.mjs'));
  });

  it('uses Resources/sleepy in the packaged app', () => {
    electron.app.isPackaged = true;
    (process as { resourcesPath?: string }).resourcesPath = '/Applications/Nightyard.app/Contents/Resources';
    expect(bundledSleepyBin()).toBe(
      path.join('/Applications/Nightyard.app/Contents/Resources', 'sleepy', 'cli', 'bin', 'sleepy.mjs'),
    );
  });

  it('prefers the user\'s own Sleepy and falls back to the built-in one', () => {
    expect(resolveSleepyBin('  /home/me/sleepy/cli/bin/sleepy.mjs ')).toBe('/home/me/sleepy/cli/bin/sleepy.mjs');
    expect(resolveSleepyBin('')).toBe(bundledSleepyBin());
    expect(resolveSleepyBin('   ')).toBe(bundledSleepyBin());
    expect(resolveSleepyBin(undefined)).toBe(bundledSleepyBin());
  });

  it('runs Sleepy with Electron in Node mode', () => {
    expect(sleepyNodeCommand()).toEqual({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('leaves an existing plugin alone', () => {
    fs.mkdirSync(sleepyPluginDir(home), { recursive: true });
    expect(ensureSleepyPlugin('/b/sleepy.mjs', {}, home)).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('links the plugin when it is missing', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'sleepy plugin linked at x\n', stderr: '' });
    const note = ensureSleepyPlugin('/b/sleepy.mjs', { PATH: '/bin' }, home);
    expect(note).toContain('sleepy plugin linked at x');
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/b/sleepy.mjs', 'link-plugin']);
    expect(opts.env).toMatchObject({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
  });

  it('replaces a dangling plugin link', () => {
    fs.mkdirSync(path.dirname(sleepyPluginDir(home)), { recursive: true });
    fs.symlinkSync(path.join(home, 'gone'), sleepyPluginDir(home), 'dir');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    expect(ensureSleepyPlugin('/b/sleepy.mjs', {}, home)).toContain('Sleepy plugin linked');
  });

  it('reports a failed link instead of throwing', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'refusing to overwrite' });
    expect(ensureSleepyPlugin('/b/sleepy.mjs', {}, home)).toContain('Could not link the Sleepy plugin');
  });
});
