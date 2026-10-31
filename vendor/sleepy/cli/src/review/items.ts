import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { readQueue, type QueueItem } from '../state/queue.js';
import { sleepyPaths } from '../paths.js';
import { markApproved } from '../commands/apply.js';
import { queueIdentity } from '../state/run-report.js';

const execFile = promisify(execFileCb);
async function git(root: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd: root, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function gitPaths(root: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFile('git', args, { cwd: root, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return stdout.split('\0').filter(Boolean);
}
async function integrationBlocker(root: string, files: string[]): Promise<string | undefined> {
  const staged = await gitPaths(root, ['diff', '--cached', '--name-only', '-z']);
  if (staged.length) return `Finish or unstage your staged changes before integrating: ${staged.join(', ')}. Unstaging keeps your edits.`;
  const local = [...await gitPaths(root, ['diff', '--name-only', '-z']),
    ...await gitPaths(root, ['ls-files', '--others', '--exclude-standard', '-z'])];
  // Git's merge strategies can overwrite ignored files; inspect only incoming paths
  // so repositories with large ignored dependency directories stay cheap to review.
  if (files.length) local.push(...await gitPaths(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...files.map(file => `:(literal)${file}`)]));
  const overlaps = local.filter(file => files.some(changed => file === changed || file.startsWith(changed + '/') || changed.startsWith(file + '/')));
  if (overlaps.length) return `This change overlaps your uncommitted work in: ${overlaps.join(', ')}. Commit or stash only those files, then retry. Your other unfinished work can stay in place.`;
}
export interface ReviewItem {
  id: string; number: number; summary: string; type: string; artifact: QueueItem['artifact'];
  approved: boolean; head: string | null; targetBranch: string; files: string[];
  diff: string; stat: string; error?: string; integration?: 'integrated'; integrationBlocker?: string;
}
/** Absolute path of a queue file artifact; throws when it points outside .sleepy/artifacts. */
export async function resolveArtifactFile(root: string, relativePath: string): Promise<string> {
  const artifacts = await realpath(sleepyPaths(root).artifactsDir);
  const file = await realpath(path.resolve(root, relativePath));
  if (!file.startsWith(artifacts + path.sep)) throw new Error('Artifact is outside .sleepy/artifacts');
  return file;
}
export async function collectReview(root: string, runId?: string): Promise<ReviewItem[]> {
  let report: { produced?: string[]; targetBranch: string } | undefined;
  if (runId) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId)) throw new Error('Invalid run ID');
    report = JSON.parse(await readFile(path.join(sleepyPaths(root).root, 'runs', runId + '.json'), 'utf8'));
    if (!Array.isArray(report?.produced)) throw new Error('This run has no completed result snapshot. It may still be running or was interrupted; inspect its queue locally.');
  }
  const targetBranch = report?.targetBranch || await git(root, ['symbolic-ref', '--short', 'HEAD']);
  const produced = report ? new Set(report.produced) : undefined;
  const rows = (await readQueue(root)).filter(i => !produced || produced.has(queueIdentity(i)));
  const results: ReviewItem[] = [];
  for (const item of rows) {
    const result: ReviewItem = { id: String(item.number), number: item.number, summary: item.summary,
      type: item.type, artifact: item.artifact, approved: item.approved, head: null, targetBranch, files: [], diff: '', stat: '' };
    try {
      if (item.artifact.kind === 'branch') {
        if (!item.artifact.name.startsWith('sleepy/')) throw new Error('Not a Sleepy branch');
        result.head = await git(root, ['rev-parse', '--verify', `${item.artifact.name}^{commit}`]);
        const base = await git(root, ['merge-base', '--', targetBranch, result.head]);
        result.files = await gitPaths(root, ['diff', '--name-only', '-z', base, result.head]);
        try { await git(root, ['merge-base', '--is-ancestor', result.head, targetBranch]); result.integration = 'integrated'; } catch {}
        if (!result.integration) {
          const blocker = await integrationBlocker(root, result.files);
          if (blocker) result.integrationBlocker = blocker;
        }
        const stat = await git(root, ['diff', '--stat', base, result.head]);
        result.stat = stat;
        result.diff = stat.slice(0, 6000);
        // Capture a bounded preview; the entire branch is what Integrate merges.
        try { result.diff += '\n\n' + (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=2', base, result.head])).slice(0,10000); }
        catch { result.diff += '\nDiff is too large to preview. Inspect the branch locally before integrating.'; }
      } else {
        const file = await resolveArtifactFile(root, item.artifact.path);
        result.files = [item.artifact.path];
        // Bound file reads before allocation, not only before returning to the UI.
        const { open } = await import('node:fs/promises');
        const handle = await open(file, 'r');
        try { const buffer = Buffer.alloc(12000); const { bytesRead } = await handle.read(buffer,0,buffer.length,0); result.diff = buffer.subarray(0,bytesRead).toString('utf8'); }
        finally { await handle.close(); }
      }
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    results.push(result);
  }
  return results;
}

export async function integrateReviewedItem(root: string, number: number, head: string, targetBranch: string) {
  if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Invalid reviewed change');
  // Same lock as sleepy start: integration never races an active supervisor.
  const release = await lockfile.lock(sleepyPaths(root).root, { retries: 0 });
  try {
    const item = (await readQueue(root)).find(row => row.number === number);
    if (!item || item.artifact.kind !== 'branch' || !item.artifact.name.startsWith('sleepy/')) throw new Error('Review item is not a Sleepy branch');
    if (await git(root, ['symbolic-ref', '--short', 'HEAD']) !== targetBranch) throw new Error('The target branch changed. Switch back to the reviewed target before integrating.');
    if (await git(root, ['rev-parse', '--verify', `${item.artifact.name}^{commit}`]) !== head) throw new Error('This change has new commits. Review it again before integrating.');
    // Detect an integration that succeeded before a response or state write was lost.
    let integrated = false;
    try { await git(root, ['merge-base', '--is-ancestor', head, 'HEAD']); integrated = true; } catch {}
    if (integrated) { await markApproved(root, number); return { status: 'already-integrated', branch: item.artifact.name }; }
    if (item.approved) throw new Error('This queue item was already approved');
    for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD']) {
      try { await git(root, ['rev-parse', '--verify', marker]); throw new Error('Finish the existing Git operation before integrating.'); }
      catch (error) { if (error instanceof Error && error.message.startsWith('Finish')) throw error; }
    }
    const targetHead = await git(root, ['rev-parse', 'HEAD']);
    const base = await git(root, ['merge-base', targetHead, head]);
    const files = await gitPaths(root, ['diff', '--name-only', '-z', base, head]);
    const blocker = await integrationBlocker(root, files);
    if (blocker) throw new Error(blocker);
    // Discover committed conflicts in a disposable checkout before touching local edits.
    const preview = await mkdtemp(path.join(os.tmpdir(), 'sleepy-integrate-'));
    try {
      await git(root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', preview, targetHead]);
      try { await git(preview, ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-commit', '--no-autostash', head]); }
      catch {
        const conflicts = await gitPaths(preview, ['diff', '--name-only', '--diff-filter=U', '-z']);
        throw new Error(`Integration could not complete${conflicts.length ? ` because of conflicts in: ${conflicts.join(', ')}` : ''}. Resolve the branch against ${targetBranch}, then refresh its review. Your project was not changed.`);
      }
    } finally {
      await git(root, ['worktree', 'remove', '--force', preview]).catch(() => {});
      await rm(preview, { recursive: true, force: true });
    }
    if (await git(root, ['rev-parse', 'HEAD']) !== targetHead || await git(root, ['symbolic-ref', '--short', 'HEAD']) !== targetBranch) throw new Error('The target changed during the integration check. Refresh the review and retry.');
    const latestBlocker = await integrationBlocker(root, files);
    if (latestBlocker) throw new Error(latestBlocker);
    try {
      // Merge the exact reviewed commit, even if someone moves the branch concurrently.
      await git(root, ['merge', '--no-ff', '--no-autostash', '--no-overwrite-ignore', '-m', `sleepy: integrate reviewed change #${number}`, head]);
    } catch (error) {
      // Abort only our merge, never an unrelated Git operation.
      let mergeHead = '';
      try { mergeHead = await git(root, ['rev-parse', '--verify', 'MERGE_HEAD']); } catch {}
      if (mergeHead === head) await git(root, ['merge', '--abort']);
      const detail = String((error as { stderr?: string }).stderr || '').trim().slice(0, 2000);
      throw new Error(`Integration could not complete. ${detail || 'Check for conflicts locally.'} No unrelated changes were reset.`);
    }
    await markApproved(root, number);
    return { status: 'merged', branch: item.artifact.name };
  } finally { await release(); }
}
