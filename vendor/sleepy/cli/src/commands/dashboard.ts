import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readConfig } from '../state/config.js';
import { readBudget } from '../state/budget.js';
import { readQueue } from '../state/queue.js';
import { readMarkdown } from '../state/markdown.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function extractBacklogTop(
  md: string | null,
  n: number,
): Array<{ num: string; title: string }> {
  if (!md) return [];
  const out: Array<{ num: string; title: string }> = [];
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
    out.push({ num: num!, title });
    if (out.length >= n) break;
  }
  return out;
}

const CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5;
         background: #0f172a; color: #e2e8f0; }
  h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; margin-top: 1.5rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .char { font-size: 2.5rem; font-family: ui-monospace, "SF Mono", Monaco, monospace; color: #fbbf24; }
  .meta { color: #94a3b8; font-size: 0.9rem; }
  .row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #1e293b; }
  .row:last-child { border-bottom: none; }
  .no-run { color: #fbbf24; font-size: 1.2rem; text-align: center; margin-top: 4rem; }
  .empty { color: #64748b; font-style: italic; }
  code { background: #1e293b; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.85em; }
  .checkbox { color: #64748b; }
  .approved { color: #22c55e; }
`;

export interface DashboardOptions {
  refreshSeconds: number;
}

export async function renderDashboardHtml(
  projectRoot: string,
  opts: DashboardOptions,
): Promise<string> {
  const cfg = await readConfig(projectRoot);
  const refresh = `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`;

  if (!cfg) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${refresh}
  <title>sleepy — no active run</title>
  <style>${CSS}</style>
</head>
<body>
  <p class="no-run">(-.-) zZz</p>
  <p class="no-run">no active run in this project</p>
</body>
</html>`;
  }

  const budget = await readBudget(projectRoot);
  const queue = await readQueue(projectRoot);
  const backlogMd = await readMarkdown(projectRoot, 'backlog');

  const mode = cfg.windDown
    ? 'alarmed'
    : budget && budget.iterations > 0
      ? 'working'
      : 'idle';
  const char =
    mode === 'idle'
      ? '(-.-) zZz'
      : mode === 'working'
        ? "(&gt;'.'&lt;)"
        : mode === 'alarmed'
          ? '(O_O)!'
          : '(^_^)';

  const capText = cfg.tokenCap ? ` / ${fmt(cfg.tokenCap)}` : '';
  const tokensRow = budget
    ? `<div class="row"><span>tokens used</span><span>${fmt(budget.tokensUsed)}${escapeHtml(capText)}</span></div>
       <div class="row"><span>iterations</span><span>${budget.iterations}</span></div>`
    : '<div class="row"><span>budget</span><span class="empty">not initialized</span></div>';

  const backlogTop = extractBacklogTop(backlogMd, 5);
  const backlogHtml =
    backlogTop.length === 0
      ? '<p class="empty">empty</p>'
      : '<ul>' +
        backlogTop
          .map((b) => `<li>${escapeHtml(b.num)}. ${escapeHtml(b.title)}</li>`)
          .join('') +
        '</ul>';

  const queueHtml =
    queue.length === 0
      ? '<p class="empty">no items awaiting review</p>'
      : '<ul>' +
        queue
          .slice(0, 20)
          .map((item) => {
            const checkbox = item.approved
              ? '<span class="approved">[x]</span>'
              : '<span class="checkbox">[ ]</span>';
            const artifactDisplay =
              item.artifact.kind === 'branch'
                ? `branch <code>${escapeHtml(item.artifact.name)}</code>`
                : `<code>${escapeHtml(item.artifact.path)}</code>`;
            return `<li>${checkbox} #${item.number} ${escapeHtml(item.summary)} — ${artifactDisplay} <span class="meta">(${escapeHtml(item.size)})</span></li>`;
          })
          .join('') +
        '</ul>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${refresh}
  <title>sleepy${cfg.dryRun ? ' (dry-run)' : ''}</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>sleepy${cfg.dryRun ? ' <span class="meta">(dry-run)</span>' : ''}</h1>
  <p class="char">${char}</p>
  <p class="meta">started ${escapeHtml(cfg.startedAt)}${cfg.deadline ? ` · deadline ${escapeHtml(cfg.deadline)}` : ''}</p>
  <h2>Status</h2>
  <div class="row"><span>intensity</span><span>${escapeHtml(cfg.currentIntensity)} <span class="meta">(ceiling ${escapeHtml(cfg.userIntensity)})</span></span></div>
  ${cfg.windDown ? '<div class="row"><span>mode</span><span>wind-down</span></div>' : ''}
  ${tokensRow}
  <h2>Backlog (top 5)</h2>
  ${backlogHtml}
  <h2>Queue (${queue.length})</h2>
  ${queueHtml}
</body>
</html>`;
}

export function dashboardCommand(): Command {
  return new Command('dashboard')
    .description('start the localhost web dashboard for this run')
    .option('--port <n>', 'TCP port', '8910')
    .option('--refresh <sec>', 'auto-refresh interval in seconds', '2')
    .action(async (opts: { port: string; refresh: string }) => {
      const port = Number(opts.port);
      const refreshSeconds = Number(opts.refresh);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`invalid --port "${opts.port}"`);
        process.exit(2);
      }
      if (!Number.isFinite(refreshSeconds) || refreshSeconds < 1) {
        console.error(`invalid --refresh "${opts.refresh}" (must be >= 1 second)`);
        process.exit(2);
      }
      const projectRoot = process.cwd();

      const handler = async (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/' || req.url === '/index.html') {
          try {
            const html = await renderDashboardHtml(projectRoot, { refreshSeconds });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(html);
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`sleepy dashboard error: ${(err as Error).message}`);
          }
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      };

      const server = createServer((req, res) => {
        void handler(req, res);
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(`sleepy dashboard: http://localhost:${port}/`);
        console.log('press Ctrl+C to exit (the sleepy run keeps going)');
      });

      const onSignal = () => {
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });
}
