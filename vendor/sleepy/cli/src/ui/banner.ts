import { brand } from './colors.js';

const BANNER_LINES = [
  '███████╗██╗     ███████╗███████╗██████╗ ██╗   ██╗',
  '██╔════╝██║     ██╔════╝██╔════╝██╔══██╗╚██╗ ██╔╝',
  '███████╗██║     █████╗  █████╗  ██████╔╝ ╚████╔╝ ',
  '╚════██║██║     ██╔══╝  ██╔══╝  ██╔═══╝   ╚██╔╝  ',
  '███████║███████╗███████╗███████╗██║        ██║   ',
  '╚══════╝╚══════╝╚══════╝╚══════╝╚═╝        ╚═╝   ',
];

const CHARACTER = '(-.-) zZz';

export function renderBanner(opts: { subtitle?: string } = {}): string {
  const lines: string[] = [''];
  for (const line of BANNER_LINES) {
    lines.push(brand.sleepy(line));
  }
  const charLine = '              ' + brand.header(CHARACTER);
  lines.push(charLine);
  if (opts.subtitle) {
    lines.push('');
    lines.push('  ' + brand.meta(opts.subtitle));
  }
  lines.push('');
  return lines.join('\n');
}

export function printBanner(opts: { subtitle?: string } = {}): void {
  process.stdout.write(renderBanner(opts) + '\n');
}
