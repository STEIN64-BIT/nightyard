/**
 * Tiny ANSI color helper — zero dependencies, TTY-aware.
 * Disables automatically when stdout isn't a TTY or NO_COLOR is set.
 */

const isColorful =
  process.stdout.isTTY === true &&
  !process.env['NO_COLOR'] &&
  process.env['TERM'] !== 'dumb';

function wrap(open: number, close = 0): (s: string) => string {
  if (!isColorful) return (s) => s;
  return (s) => `\x1b[${open}m${s}\x1b[${close}m`;
}

// Foreground colors
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);
export const gray = wrap(90);

// Bright variants
export const brightYellow = wrap(93);
export const brightCyan = wrap(96);
export const brightMagenta = wrap(95);

// Modifiers
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);

/**
 * Sleepy brand palette. The character is always yellow. Orchestrator
 * output is cyan; worker output is magenta; success is green; errors red.
 */
export const brand = {
  sleepy: (s: string) => bold(yellow(s)),
  header: (s: string) => bold(brightYellow(s)),
  orchestrator: (s: string) => cyan(s),
  worker: (s: string) => magenta(s),
  success: (s: string) => green(s),
  error: (s: string) => red(s),
  meta: (s: string) => dim(s),
  divider: (s: string) => dim(s),
};
