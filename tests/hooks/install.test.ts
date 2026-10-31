import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const TMP = path.join(os.tmpdir(), 'nightyard-extra-hooks-install-test-' + process.pid);
const FAKE_HOME = path.join(TMP, 'home');
const SETTINGS = path.join(FAKE_HOME, '.claude', 'settings.json');
const REPO = path.resolve(__dirname, '..', '..');
const INSTALLER = path.join(REPO, 'hooks', 'install.js');
const UNINSTALLER = path.join(REPO, 'hooks', 'uninstall.js');

function runInstall() {
  return execSync(`node "${INSTALLER}"`, { encoding: 'utf-8', env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME } });
}
function runUninstall() {
  return execSync(`node "${UNINSTALLER}"`, { encoding: 'utf-8', env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME } });
}
function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf-8'));
}

describe('hooks installer', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('installs hooks on UserPromptSubmit and SessionStart', () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({}));
    runInstall();
    const s = readSettings();
    expect(s.hooks.UserPromptSubmit.length).toBeGreaterThan(0);
    expect(s.hooks.SessionStart.length).toBeGreaterThan(0);
    const cmds = [
      ...s.hooks.UserPromptSubmit.flatMap((m: any) => m.hooks.map((h: any) => h.command)),
      ...s.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command)),
    ];
    expect(cmds.some((c: string) => c.includes('clock.py') && c.includes('# nightyard-extra-hook'))).toBe(true);
    expect(cmds.some((c: string) => c.includes('memory_bootstrap.py') && c.includes('# nightyard-extra-hook'))).toBe(true);
  });

  it('preserves existing nightyard-hook entries', () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'echo vy # nightyard-hook' }],
        }],
      },
    }));
    runInstall();
    const s = readSettings();
    const cmds = s.hooks.UserPromptSubmit.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds).toContain('echo vy # nightyard-hook');
  });

  it('is idempotent — running twice yields the same number of extra hooks', () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({}));
    runInstall();
    const first = JSON.stringify(readSettings().hooks);
    runInstall();
    const second = JSON.stringify(readSettings().hooks);
    expect(first).toBe(second);
  });

  it('uninstall removes only the extra hooks', () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'echo vy # nightyard-hook' }],
        }],
      },
    }));
    runInstall();
    runUninstall();
    const s = readSettings();
    const cmds = s.hooks.UserPromptSubmit.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds).toContain('echo vy # nightyard-hook');
    expect(cmds.some((c: string) => c.includes('# nightyard-extra-hook'))).toBe(false);
  });

  it('install and uninstall also clean up hooks written with the legacy marker', () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: '/usr/bin/python3 /old/clock.py # stein-hook' }],
        }],
      },
    }));
    runInstall();
    let cmds = readSettings().hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes('# stein-hook'))).toBe(false);
    runUninstall();
    expect(readSettings().hooks.SessionStart).toBeUndefined();
  });
});
