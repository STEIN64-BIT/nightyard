import { Command } from 'commander';
import { collectReview, integrateReviewedItem, type ReviewItem } from '../review/items.js';
import { brand } from '../ui/colors.js';

function status(item: ReviewItem): string {
  if (item.error) return brand.error('✗ ' + item.error);
  if (item.integration === 'integrated') return brand.success('✓ already in ' + item.targetBranch);
  if (item.approved) return brand.success('✓ approved');
  if (item.integrationBlocker) return brand.error('blocked: ') + item.integrationBlocker;
  if (item.artifact.kind === 'branch') return 'ready to integrate';
  return brand.meta('document');
}

/** Human-readable review list; `--json` keeps the structured form for UIs. */
export function renderReview(items: ReviewItem[]): string {
  if (items.length === 0) return `${brand.sleepy('sleepy:')} nothing to review in this queue.`;
  const lines: string[] = [];
  for (const item of items) {
    const where = item.artifact.kind === 'branch' ? item.artifact.name : item.artifact.path;
    lines.push(`${brand.header('#' + item.number)} ${item.summary} ${brand.meta('(' + item.type + ')')}`);
    lines.push(`   ${brand.meta(where)} · ${item.files.length} file${item.files.length === 1 ? '' : 's'} · ${status(item)}`);
    if (item.artifact.kind === 'branch' && item.head && !item.integration && !item.approved && !item.integrationBlocker && !item.error) {
      lines.push(`   ${brand.meta('integrate:')} sleepy review --integrate ${item.number} --head ${item.head} --target ${item.targetBranch}`);
    }
  }
  return lines.join('\n');
}

export function reviewCommand(): Command {
  return new Command('review').description('Review what a run produced, or integrate one reviewed branch')
    .option('--json', 'print structured review data')
    .option('--run <id>', 'only changes produced by this run')
    .option('--integrate <number>', 'integrate one queue item')
    .option('--head <sha>', 'reviewed branch commit')
    .option('--target <branch>', 'reviewed target branch')
    .action(async (opts: { json?: boolean; integrate?: string; head?: string; target?: string; run?: string }) => {
      try {
        if (opts.integrate) {
          const result = await integrateReviewedItem(process.cwd(), Number(opts.integrate), opts.head || '', opts.target || '');
          console.log(opts.json ? JSON.stringify(result)
            : `${brand.sleepy('sleepy:')} ${brand.success('✓')} ${result.status === 'already-integrated' ? 'already integrated' : 'integrated'} ${result.branch}`);
          return;
        }
        const items = await collectReview(process.cwd(), opts.run);
        console.log(opts.json ? JSON.stringify(items) : renderReview(items));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(opts.json ? JSON.stringify({ error: message }) : `${brand.sleepy('sleepy:')} ${brand.error('✗')} ${message}`);
        process.exitCode = 1;
      }
    });
}
