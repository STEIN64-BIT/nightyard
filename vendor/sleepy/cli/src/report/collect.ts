import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../state/config.js';
import { readBudget } from '../state/budget.js';
import { readQueue, type QueueItemType } from '../state/queue.js';
import { collectReview, resolveArtifactFile } from '../review/items.js';
import { sleepyPaths } from '../paths.js';
import { renderMarkdown } from './markdown.js';
import { extractSummary, extractTitle } from './summary.js';

export interface ReportBranch {
  name: string;
  head: string | null;
  targetBranch: string;
  files: string[];
  stat: string;
}

export interface ReportArtifact {
  relativePath: string;
  absolutePath: string;
  title: string;
  summaryHtml: string;
  summaryFound: boolean;
  bodyHtml: string;
  words: number;
  truncated: boolean;
}

export interface ReportItem {
  number: number;
  type: QueueItemType;
  title: string;
  approved: boolean;
  addedAt: string;
  size: string;
  branch?: ReportBranch;
  artifact?: ReportArtifact;
  error?: string;
}

export interface ReportFacts {
  startedAt?: string;
  deadline?: string;
  intensity?: string;
  iterations: number;
  tokensUsed: number;
  termination?: string;
}

export interface ReportData {
  project: string;
  root: string;
  runId?: string;
  scope: 'run' | 'queue';
  scopeFallback: boolean;
  generatedAt: string;
  goals?: string;
  facts: ReportFacts;
  items: ReportItem[];
}

// Enough for any artifact a worker writes; protects the page against a
// runaway file. Truncation is shown in the report.
const MAX_ARTIFACT_BYTES = 512 * 1024;

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim() || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readArtifact(root: string, relativePath: string, fallbackTitle: string): Promise<ReportArtifact> {
  // resolveArtifactFile canonicalizes symlinks for a safe read; the report
  // shows the plain, non-canonicalized path so it matches the project root
  // as given (macOS resolves TMPDIR through /private, which would otherwise
  // leak into a path nobody recognizes).
  const resolved = await resolveArtifactFile(root, relativePath);
  const absolutePath = path.resolve(root, relativePath);
  const buffer = await readFile(resolved);
  const truncated = buffer.length > MAX_ARTIFACT_BYTES;
  const md = buffer.subarray(0, MAX_ARTIFACT_BYTES).toString('utf8');
  const summary = extractSummary(md);
  return {
    relativePath,
    absolutePath,
    title: extractTitle(md, fallbackTitle),
    summaryHtml: renderMarkdown(summary.text),
    summaryFound: summary.found,
    bodyHtml: renderMarkdown(md),
    words: md.split(/\s+/).filter(Boolean).length,
    truncated,
  };
}

export async function collectReportData(
  root: string,
  opts: { runId?: string; termination?: string; now?: Date } = {},
): Promise<ReportData> {
  const paths = sleepyPaths(root);
  const [config, budget, goals, reviewed, queue] = await Promise.all([
    readConfig(root),
    readBudget(root),
    readOptional(path.join(paths.root, 'USER_GOALS.md')),
    collectReview(root, opts.runId),
    readQueue(root),
  ]);
  const rows = new Map(queue.map((q) => [q.number, q]));

  const items: ReportItem[] = [];
  for (const r of reviewed) {
    const item: ReportItem = {
      number: r.number,
      type: r.type as QueueItemType,
      title: r.summary,
      approved: r.approved,
      addedAt: rows.get(r.number)?.addedAt ?? '',
      size: rows.get(r.number)?.size ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
    if (!r.error) {
      if (r.artifact.kind === 'branch') {
        item.branch = { name: r.artifact.name, head: r.head, targetBranch: r.targetBranch, files: r.files, stat: r.stat };
      } else {
        try {
          item.artifact = await readArtifact(root, r.artifact.path, r.summary);
        } catch (err) {
          item.error = (err as Error).message;
        }
      }
    }
    items.push(item);
  }

  const facts: ReportFacts = {
    iterations: budget?.iterations ?? 0,
    tokensUsed: budget?.tokensUsed ?? 0,
    ...(config?.startedAt ? { startedAt: config.startedAt } : {}),
    ...(config?.deadline ? { deadline: config.deadline } : {}),
    ...(config?.currentIntensity ? { intensity: config.currentIntensity } : {}),
    ...(opts.termination ? { termination: opts.termination } : {}),
  };

  return {
    project: path.basename(root),
    root,
    ...(opts.runId ? { runId: opts.runId } : {}),
    scope: opts.runId ? 'run' : 'queue',
    scopeFallback: false,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    ...(goals ? { goals } : {}),
    facts,
    items,
  };
}
