import { describe, it, expect } from 'vitest';
import { matchDialog, isDestructiveContext, stripAnsi } from './dialog-matcher';

describe('dialog-matcher', () => {
  it('strips ANSI escapes', () => {
    expect(stripAnsi('\x1b[1m❯ 1. Yes\x1b[0m')).toBe('❯ 1. Yes');
  });

  it('matches the folder-trust dialog → Enter (default is Yes)', () => {
    const m = matchDialog('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit');
    expect(m).toMatchObject({ kind: 'trust', keys: '\r' });
  });

  it('matches a permission menu → presses 1', () => {
    const m = matchDialog('Do you want to make this edit to foo.ts?\n❯ 1. Yes\n  2. Yes, allow all edits\n  3. No');
    expect(m).toMatchObject({ kind: 'permission', keys: '1' });
  });

  it('matches plan approval → presses 1', () => {
    const m = matchDialog('Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Yes, and manually approve edits\n  3. No, keep planning');
    expect(m).toMatchObject({ kind: 'plan-approval', keys: '1' });
  });

  it('matches a retry prompt → Enter', () => {
    const m = matchDialog('API error. Try again?\n❯ 1. Retry\n  2. Cancel');
    expect(m).toMatchObject({ kind: 'retry', keys: '\r' });
  });

  it('returns null with no dialog marker on screen', () => {
    expect(matchDialog('$ npm test\nall green')).toBeNull();
    expect(matchDialog('I will now delete the old config file and rewrite it.')).toBeNull();
  });

  it('NEVER fires on destructive contexts, even with a menu present', () => {
    const screens = [
      'Do you want to delete 14 files?\n❯ 1. Yes\n  2. No',
      'This will overwrite existing data. Proceed?\n❯ 1. Yes\n  2. No',
      'Run `git push --force`?\n❯ 1. Yes\n  2. No',
      'Run `rm -rf build/`?\n❯ 1. Yes\n  2. No',
      'git reset --hard origin/main — continue?\n❯ 1. Yes\n  2. No',
    ];
    for (const s of screens) {
      expect(isDestructiveContext(s)).toBe(true);
      expect(matchDialog(s)).toBeNull();
    }
  });

  it('rejects the trust phrase quoted in plain prose without a menu marker', () => {
    const m = matchDialog(
      "Note: Claude Code shows 'Do you trust the files in this folder?' on first run"
    );
    expect(m).toBeNull();
  });

  it('NEVER fires on destructive natural-language paraphrases, even with a menu present', () => {
    const screens = [
      'About to truncate the users table. Do you want to proceed?\n❯ 1. Yes\n  2. No',
      'This will purge all local branches permanently. Do you want to proceed?\n❯ 1. Yes\n  2. No',
      'This will hard reset your branch and lose uncommitted work. Do you want to proceed?\n❯ 1. Yes\n  2. No',
    ];
    for (const s of screens) {
      expect(isDestructiveContext(s)).toBe(true);
      expect(matchDialog(s)).toBeNull();
    }
  });

  it('NEVER fires when a terminal hard-wrap splits the destructive word or flag', () => {
    const screens = [
      'Do you want to overwr\nite the file?\n❯ 1. Yes\n  2. No',
      'Run git reset --\nhard now?\n❯ 1. Yes',
      // …and the same wrap under a cue that would otherwise auto-answer
      'Do you want to run git reset --\nhard?\n❯ 1. Yes\n  2. No',
      'This will drop\ntable users. Do you want to proceed?\n❯ 1. Yes\n  2. No',
      'Do you want to proceed? You may lose\nuncommitted work.\n❯ 1. Yes\n  2. No',
    ];
    for (const s of screens) {
      expect(isDestructiveContext(s)).toBe(true);
      expect(matchDialog(s)).toBeNull();
    }
  });

  it('strips OSC-8 hyperlink sequences between ❯ and the menu number so a real dialog still matches', () => {
    const screen =
      'Do you want to make this edit to foo.ts?\n' +
      '❯ \x1b]8;;https://example.com\x07\x1b]8;;\x07 1. Yes\n' +
      '  2. No';
    const m = matchDialog(screen);
    expect(m).toMatchObject({ kind: 'permission', keys: '1' });
  });
});
