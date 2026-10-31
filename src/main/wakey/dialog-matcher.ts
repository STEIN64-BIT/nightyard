export interface DialogMatch { kind: 'trust' | 'permission' | 'plan-approval' | 'retry'; keys: string; label: string }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-Z\\-_]/g;
export function stripAnsi(s: string): string { return s.replace(ANSI, ''); }

/** Dumb keyword list. False positives only cost a fast-path; misses cost data. */
const DESTRUCTIVE =
  /(delete|remove|overwrite|force[- ]push|push --force|reset --hard|hard[- ]?reset|rm -rf|drop (table|database)|destroy|uninstall|discard|truncate|purge|wipe|erase|permanently|(?:lose|losing)\b.{0,40}?\b(?:work|data|changes)\b)/i;

/**
 * The same list respelled without spaces, for the whitespace-REMOVED reading of
 * the screen. A terminal hard-wrap splits words mid-token (`overwr\nite`) and
 * flags mid-flag (`reset --\nhard`); gluing the screen back together recovers
 * both, but every multi-word phrase loses its spaces in the same move, so the
 * phrases need their own spelling here. (The phrase-with-gap patterns —
 * `lose … work` — are covered by the collapsed reading instead.)
 */
const DESTRUCTIVE_UNWRAPPED =
  /(delete|remove|overwrite|force-?push|push--force|reset--hard|hard-?reset|rm-rf|drop(table|database)|destroy|uninstall|discard|truncate|purge|wipe|erase|permanently)/i;

/**
 * Destructive if ANY of three readings of the screen trips the list: as-is,
 * with runs of whitespace collapsed to one space (a wrapped phrase, or one
 * whose words `.` could not span because a newline sits between them), and with
 * whitespace removed entirely (a wrapped word). One dialog cue plus a wrapped
 * `overwrite` used to be enough to get an auto-answer.
 */
export function isDestructiveContext(screen: string): boolean {
  const s = stripAnsi(screen);
  return DESTRUCTIVE.test(s)
    || DESTRUCTIVE.test(s.replace(/\s+/g, ' '))
    || DESTRUCTIVE_UNWRAPPED.test(s.replace(/\s+/g, ''));
}

const MENU = /❯\s*1\./;

export function matchDialog(screenTail: string): DialogMatch | null {
  const s = stripAnsi(screenTail);
  if (isDestructiveContext(s)) return null;
  if (!MENU.test(s)) return null;
  if (/do you trust the files in this folder/i.test(s)) {
    return { kind: 'trust', keys: '\r', label: 'auto-answered folder-trust dialog' };
  }
  if (/would you like to proceed/i.test(s)) {
    return { kind: 'plan-approval', keys: '1', label: 'auto-approved plan' };
  }
  if (/(try again|retry)/i.test(s)) {
    return { kind: 'retry', keys: '\r', label: 'auto-retried after error' };
  }
  if (/do you want/i.test(s)) {
    return { kind: 'permission', keys: '1', label: 'auto-answered permission prompt' };
  }
  return null;
}
