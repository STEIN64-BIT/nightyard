import { Command } from 'commander';
import { initSleepyDir } from '../state/init.js';
import { checkCwdSafety } from '../state/cwd-safety.js';

export function initCommand(): Command {
  return new Command('init')
    .description('create .sleepy/ in the current directory')
    .option('--force', 'skip the cwd safety check (for experts)')
    .action(async (opts: { force?: boolean }) => {
      if (!opts.force) {
        const safety = checkCwdSafety(process.cwd());
        if (!safety.ok) {
          console.error(`sleepy: ${safety.reason}`);
          console.error(`  (if you really mean it, pass --force)`);
          process.exit(1);
        }
        for (const warning of safety.warnings) {
          console.error(`sleepy: warning — ${warning}`);
        }
      }
      const result = await initSleepyDir(process.cwd());
      if (result.created) {
        console.log(`Initialized sleepy at ${result.root}`);
      } else {
        console.log(`sleepy already initialized at ${result.root}`);
      }
    });
}
