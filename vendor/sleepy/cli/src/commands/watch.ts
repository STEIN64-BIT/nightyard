import { Command } from 'commander';
import { readConfig } from '../state/config.js';
import { readBudget } from '../state/budget.js';
import { readQueue } from '../state/queue.js';
import { readMarkdown } from '../state/markdown.js';

export type CharacterMode = 'idle' | 'working' | 'done' | 'alarmed';

export function pickCharacter(state: { mode: CharacterMode }): string {
  switch (state.mode) {
    case 'idle':
      return '(-.-) zZz';
    case 'working':
      return "(>'.'<)";
    case 'done':
      return '(^_^)';
    case 'alarmed':
      return '(O_O)!';
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function extractBacklogTop(md: string | null, n: number): string[] {
  if (!md) return [];
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue;
    if (line.includes('| #') && line.includes('| Category')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(
        (c, i, arr) =>
          !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''),
      );
    if (cells.length < 3) continue;
    const num = cells[0];
    const title = cells[2] ?? '';
    if (!/^\d+$/.test(num ?? '')) continue;
    out.push(`${num!.padStart(2)}. ${title}`);
    if (out.length >= n) break;
  }
  return out;
}

export async function renderWatchFrame(projectRoot: string): Promise<string> {
  const cfg = await readConfig(projectRoot);
  if (!cfg) {
    return 'sleepy: no active run in this project (no .sleepy/config.json)';
  }
  const budget = await readBudget(projectRoot);
  const queue = await readQueue(projectRoot);
  const backlogMd = await readMarkdown(projectRoot, 'backlog');

  const mode: CharacterMode = cfg.windDown
    ? 'alarmed'
    : budget && budget.iterations > 0
      ? 'working'
      : 'idle';
  const char = pickCharacter({ mode });

  const lines: string[] = [];
  lines.push('┌─ sleepy ─────────────────────────────────────────────────────────┐');
  lines.push(`│   ${char}                                                         `);
  lines.push('│');
  lines.push(`│   intensity: ${cfg.currentIntensity}   (user ceiling: ${cfg.userIntensity})`);
  lines.push(`│   dry-run: ${cfg.dryRun ? 'yes' : 'no'}   wind-down: ${cfg.windDown ? 'yes' : 'no'}`);
  if (budget) {
    const capText = cfg.tokenCap ? ` / ${fmt(cfg.tokenCap)}` : '';
    lines.push(`│   tokens: ${fmt(budget.tokensUsed)}${capText}`);
    lines.push(`│   iterations: ${budget.iterations}`);
  } else {
    lines.push('│   budget: (not initialized)');
  }
  lines.push('│');
  lines.push('│   Backlog (top 5)');
  const top = extractBacklogTop(backlogMd, 5);
  if (top.length === 0) {
    lines.push('│     (empty)');
  } else {
    for (const row of top) lines.push(`│     ${row}`);
  }
  lines.push('│');
  lines.push(`│   Queue: ${queue.length} item(s) awaiting review`);
  if (queue.length > 0) {
    for (const item of queue.slice(0, 5)) {
      const tick = item.approved ? '[x]' : '[ ]';
      lines.push(`│     ${tick} #${item.number} ${item.summary}`);
    }
  }
  lines.push('│');
  lines.push('└──────────────────────────────────────────────────────────────────┘');
  lines.push('    press Ctrl+C to exit the dashboard (the sleepy run keeps going)');
  return lines.join('\n');
}

const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export function watchCommand(): Command {
  return new Command('watch')
    .description('open a live terminal dashboard for the current run')
    .option('--interval <ms>', 'refresh interval in milliseconds', '2000')
    .action(async (opts: { interval: string }) => {
      const intervalMs = Number(opts.interval);
      if (!Number.isFinite(intervalMs) || intervalMs < 250) {
        console.error('invalid --interval; must be >= 250ms');
        process.exit(2);
      }
      const projectRoot = process.cwd();
      const render = async () => {
        const frame = await renderWatchFrame(projectRoot);
        process.stdout.write(CLEAR_SCREEN + frame + '\n');
      };
      await render();
      const timer = setInterval(render, intervalMs);
      const onSignal = () => {
        clearInterval(timer);
        process.stdout.write('\n');
        process.exit(0);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      await new Promise(() => {});
    });
}
