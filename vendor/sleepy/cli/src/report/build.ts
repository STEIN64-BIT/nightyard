import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { sleepyPaths } from '../paths.js';
import { readSettings, type SleepySettings } from '../state/settings.js';
import { collectReportData } from './collect.js';
import { renderReportHtml } from './html.js';
import { runPublishCommand, type PublishResult } from './publish.js';

export interface BuildReportResult {
  reportPath: string;
  latestPath: string;
  items: number;
  publish?: PublishResult & { command: string };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function writePrivate(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    // The temp file is only ever half-written or fully written here; either
    // way it must not linger if the rename never happens.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function buildReport(
  root: string,
  opts: { runId?: string; termination?: string; publish?: boolean; now?: Date; settings?: SleepySettings } = {},
): Promise<BuildReportResult> {
  const now = opts.now ?? new Date();
  const collectOpts = { ...(opts.termination ? { termination: opts.termination } : {}), now };
  let data;
  try {
    data = await collectReportData(root, { ...collectOpts, ...(opts.runId ? { runId: opts.runId } : {}) });
  } catch (err) {
    // A run id without a finished snapshot still deserves a report: fall
    // back to the whole queue, but keep the run id as the file name. This
    // covers two shapes from collectReview: the run file exists but is
    // missing its `produced` array (an interrupted run — "no completed
    // result snapshot"), and the run file does not exist at all (an old or
    // unknown run id — a plain ENOENT on .sleepy/runs/<id>.json).
    const runFile = opts.runId ? path.join(sleepyPaths(root).runsDir, `${opts.runId}.json`) : undefined;
    const missingSnapshot =
      /no completed result snapshot/.test((err as Error).message) ||
      ((err as NodeJS.ErrnoException).code === 'ENOENT' && (err as NodeJS.ErrnoException).path === runFile);
    if (!opts.runId || !missingSnapshot) throw err;
    data = await collectReportData(root, collectOpts);
    data = { ...data, runId: opts.runId, scope: 'run' as const, scopeFallback: true };
  }

  const dir = sleepyPaths(root).reportsDir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reportPath = path.join(dir, `${opts.runId ?? stamp(now)}.html`);
  const latestPath = path.join(dir, 'latest.html');
  const html = renderReportHtml(data);
  // Both files are written temp-file-then-rename so neither is ever visible
  // to a reader (or left on disk) half-written or with non-private
  // permissions, even momentarily.
  await writePrivate(reportPath, html);
  await writePrivate(latestPath, html);

  const result: BuildReportResult = { reportPath, latestPath, items: data.items.length };
  if (opts.publish !== false) {
    const settings = opts.settings ?? (await readSettings(root));
    const command = settings.report?.publishCommand;
    if (command) {
      const publish = await runPublishCommand(command, {
        cwd: root,
        env: { SLEEPY_REPORT_PATH: reportPath, SLEEPY_PROJECT: data.project },
      });
      result.publish = { ...publish, command };
    }
  }
  return result;
}
