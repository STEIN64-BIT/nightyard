import { Command } from 'commander';
import { readConfig } from '../state/config.js';
import { readBudget } from '../state/budget.js';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export async function statusText(projectRoot: string): Promise<string> {
  const cfg = await readConfig(projectRoot);
  if (!cfg) {
    return 'sleepy: no active run in this project (no .sleepy/config.json)';
  }
  const budget = await readBudget(projectRoot);
  const lines: string[] = [];
  lines.push(cfg.dryRun ? 'sleepy (DRY-RUN)' : 'sleepy');
  if (cfg.windDown) {
    lines.push('  mode: wind-down');
  }
  lines.push(`  intensity: ${cfg.currentIntensity}`);
  lines.push(`  user ceiling: ${cfg.userIntensity}`);
  lines.push(`  started: ${cfg.startedAt}`);
  if (cfg.deadline) {
    lines.push(`  deadline: ${cfg.deadline}`);
  }
  if (budget) {
    const capText = cfg.tokenCap ? ` of ${fmt(cfg.tokenCap)}` : '';
    lines.push(`  tokens used: ${fmt(budget.tokensUsed)}${capText}`);
    lines.push(`  iterations: ${budget.iterations}`);
    lines.push(`  updated: ${budget.updatedAt}`);
  } else {
    lines.push('  budget: (not yet initialized)');
  }
  return lines.join('\n');
}

export function statusCommand(): Command {
  return new Command('status')
    .description('print a one-shot snapshot of the current run')
    .action(async () => {
      console.log(await statusText(process.cwd()));
    });
}
