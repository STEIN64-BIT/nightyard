import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { buildReport, type BuildReportResult } from '../report/build.js';
import { brand } from '../ui/colors.js';

export function openerFor(platform: NodeJS.Platform): { command: string; args: (file: string) => string[] } {
  if (platform === 'darwin') return { command: 'open', args: (file) => [file] };
  if (platform === 'win32') return { command: 'cmd', args: (file) => ['/c', 'start', '', file] };
  return { command: 'xdg-open', args: (file) => [file] };
}

export function openInBrowser(file: string): void {
  const opener = openerFor(process.platform);
  const child = spawn(opener.command, opener.args(file), { detached: true, stdio: 'ignore' });
  // A missing opener binary (e.g. no xdg-open on a minimal Linux) emits
  // 'error' on the child; without a listener that is an uncaught exception
  // that would crash the process after the report was already written.
  child.on('error', (err) => console.error(`sleepy: could not open ${file} — ${err.message}`));
  child.unref();
}

function summarise(result: BuildReportResult): string[] {
  const lines = [`${brand.sleepy('sleepy:')} report → ${brand.header(result.reportPath)} ${brand.meta('(' + result.items + ' item' + (result.items === 1 ? '' : 's') + ')')}`];
  if (result.publish) {
    const p = result.publish;
    if (p.ok) lines.push(`         ${brand.success('✓')} published with ${brand.meta(p.command)}`);
    else lines.push(`         ${brand.error('✗')} publish command ${p.timedOut ? 'timed out' : 'failed (exit ' + p.exitCode + ')'}: ${brand.meta(p.command)}`, ...p.output.trim().split('\n').filter(Boolean).slice(-5).map((l) => `           ${brand.meta(l)}`));
  }
  return lines;
}

/** Called by `sleepy start` when a run ends. Never throws: the run's exit status is not the report's. */
export async function reportAfterRun(root: string, runId: string | undefined, termination: string | undefined): Promise<void> {
  try {
    const result = await buildReport(root, { ...(runId ? { runId } : {}), ...(termination ? { termination } : {}) });
    for (const line of summarise(result)) console.log(line);
  } catch (err) {
    console.log(`${brand.sleepy('sleepy:')} ${brand.error('could not build the report')} — ${(err as Error).message}`);
  }
}

export function reportCommand(): Command {
  return new Command('report')
    .description('Write one readable HTML report of what sleepy built and wrote')
    .option('--run <id>', 'only what this run produced')
    .option('--open', 'open the report in your browser')
    .option('--no-publish', 'skip the publish command from settings')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { run?: string; open?: boolean; publish: boolean; json?: boolean }) => {
      const root = process.cwd();
      try {
        const result = await buildReport(root, { ...(opts.run ? { runId: opts.run } : {}), publish: opts.publish });
        if (opts.json) console.log(JSON.stringify(result));
        else for (const line of summarise(result)) console.log(line);
        if (opts.open) openInBrowser(result.reportPath);
        if (result.publish && !result.publish.ok) process.exitCode = 1;
      } catch (err) {
        if (opts.json) console.log(JSON.stringify({ error: (err as Error).message }));
        else console.error(`sleepy: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
