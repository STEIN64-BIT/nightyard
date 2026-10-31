import { Command } from 'commander';
import { reviewCommand } from './commands/review.js';
import { reportCommand } from './commands/report.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { linkPluginCommand } from './commands/link-plugin.js';
import { stopCommand } from './commands/stop.js';
import { startCommand } from './commands/start.js';
import { applyCommand } from './commands/apply.js';
import { discardCommand } from './commands/discard.js';
import { whyCommand } from './commands/why.js';
import { watchCommand } from './commands/watch.js';
import { dashboardCommand } from './commands/dashboard.js';
import { goCommand } from './commands/go.js';

const VERSION = '0.4.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('sleepy')
    .description('Autonomous Claude Code loop')
    .version(VERSION);
  program.addCommand(reviewCommand());
  program.addCommand(reportCommand());
  program.addCommand(initCommand());
  program.addCommand(statusCommand());
  program.addCommand(doctorCommand());
  program.addCommand(linkPluginCommand());
  program.addCommand(stopCommand());
  program.addCommand(startCommand());
  program.addCommand(applyCommand());
  program.addCommand(discardCommand());
  program.addCommand(whyCommand());
  program.addCommand(watchCommand());
  program.addCommand(dashboardCommand());
  program.addCommand(goCommand());
  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
