import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeLauncher } from './launcher.js';
import type { NextAction, WorkerKind } from '../state/next-action.js';
import { sleepyPaths } from '../paths.js';
import {
  listWorkingTreeChanges,
  matchDenyPaths,
  snapshotWorkingTree,
} from './diff-check.js';

/**
 * Dispatch an "artifact worker" — a non-code Claude session that reads the
 * project and web, then writes a single markdown artifact. Used for research,
 * design/brainstorm, and content-generation tasks that don't touch the
 * project's source code.
 *
 * Unlike dispatchWorker (code worker), artifact workers:
 *   - Do NOT create a git worktree or branch
 *   - Run Claude in the project root directly
 *   - Write exactly one file to .sleepy/artifacts/<kind>/<slug>.md
 *
 * Because they share the user's working tree, the supervisor snapshots git
 * status before and after the run. Any write other than the artifact is a
 * violation and comes back as `rejected`, with deny-path matches listed
 * separately. Detection only — stray writes are left in place for the user.
 */

const ARTIFACT_DIR_BY_KIND: Record<Exclude<WorkerKind, 'code'>, string> = {
  research: 'research',
  design: 'plans',
  content: 'content',
};

const ARTIFACT_LABEL_BY_KIND: Record<Exclude<WorkerKind, 'code'>, string> = {
  research: 'research',
  design: 'plan',
  content: 'content',
};

/**
 * 'clean' — git saw no writes besides the artifact.
 * 'unavailable' — the project root is not a git repo, so nothing was checked.
 */
export type StrayWriteCheck = 'clean' | 'unavailable';

export type ArtifactDispatchResult =
  | {
      status: 'success';
      artifactPath: string;
      relativePath: string;
      sizeSummary: string;
      strayCheck: StrayWriteCheck;
    }
  | { status: 'no-output'; relativePath: string; strayCheck: StrayWriteCheck }
  | {
      status: 'rejected';
      relativePath: string;
      strayFiles: string[];
      offendingFiles: string[];
      matchedPatterns: string[];
    }
  | { status: 'failed'; error: string };

export interface BuildArtifactWorkerPromptInput {
  action: Extract<NextAction, { kind: 'dispatch-worker' }>;
  workerKind: Exclude<WorkerKind, 'code'>;
  rulesMdContent: string;
  skillContent: string;
  artifactRelativePath: string;
}

const ARTIFACT_PROMPT_PREFIX = `You are a sleepy artifact worker. The sleepy supervisor has dispatched you to produce ONE markdown artifact — not code. You are running in the project's root directory. You may read any file in the project, use web search, and browse documentation, but you must NOT modify any source file. Your only write is the single artifact file at the path given in the task.

When you finish, exit cleanly. The supervisor will read your artifact and append a row to the review queue.

`;

export function buildArtifactWorkerPrompt(
  input: BuildArtifactWorkerPromptInput,
): string {
  const task = [
    `Artifact kind: ${ARTIFACT_LABEL_BY_KIND[input.workerKind]}`,
    `Title: ${input.action.title}`,
    `Category: ${input.action.category}`,
    `Scope: ${input.action.scope}`,
    `Reasoning from the orchestrator: ${input.action.reasoning}`,
    '',
    `WRITE YOUR OUTPUT TO EXACTLY THIS FILE: ${input.artifactRelativePath}`,
    `(relative to the project root). Do not write anywhere else.`,
  ].join('\n');
  const rules = input.rulesMdContent.trim() || '(no rules file)';
  const skill = input.skillContent.replace(/^---\n[\s\S]*?\n---\n+/, '');
  return (
    ARTIFACT_PROMPT_PREFIX +
    '===== TASK =====\n' +
    task +
    '\n\n===== PROJECT RULES (from .sleepy/SLEEPY_RULES.md) =====\n' +
    rules +
    '\n\n===== sleepy-' +
    input.workerKind +
    ' skill =====\n' +
    skill
  );
}

export interface DispatchArtifactWorkerInput {
  projectRoot: string;
  launcher: ClaudeLauncher;
  action: Extract<NextAction, { kind: 'dispatch-worker' }>;
  workerKind: Exclude<WorkerKind, 'code'>;
  rulesMdContent: string;
  skillContent: string;
  denyPaths?: string[];
}

function toPosixRelative(projectRoot: string, absPath: string): string {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

export async function dispatchArtifactWorker(
  input: DispatchArtifactWorkerInput,
): Promise<ArtifactDispatchResult> {
  const subdir = ARTIFACT_DIR_BY_KIND[input.workerKind];
  const relativePath = `.sleepy/artifacts/${subdir}/${input.action.slug}.md`;
  const absolutePath = path.join(input.projectRoot, relativePath);

  // Ensure the artifacts subdir exists so the worker can just write to it
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const prompt = buildArtifactWorkerPrompt({
    action: input.action,
    workerKind: input.workerKind,
    rulesMdContent: input.rulesMdContent,
    skillContent: input.skillContent,
    artifactRelativePath: relativePath,
  });

  const before = await snapshotWorkingTree(input.projectRoot);

  const result = await input.launcher.run({
    prompt,
    cwd: input.projectRoot,
  });

  // Check for stray writes before anything else — a worker that crashed
  // half-way through editing a source file is still a violation.
  const after = before ? await snapshotWorkingTree(input.projectRoot) : null;
  const strayCheck: StrayWriteCheck = before && after ? 'clean' : 'unavailable';
  if (before && after) {
    const paths = sleepyPaths(input.projectRoot);
    // The artifact itself, plus control flags `sleepy stop` / ESC may drop mid-run
    const expected = new Set([
      relativePath,
      toPosixRelative(input.projectRoot, paths.stopFlag),
      toPosixRelative(input.projectRoot, paths.panicFlag),
    ]);
    const strayFiles = (
      await listWorkingTreeChanges(input.projectRoot, before, after)
    ).filter((file) => !expected.has(file));
    if (strayFiles.length > 0) {
      const { offendingFiles, matchedPatterns } = matchDenyPaths(
        strayFiles,
        input.denyPaths ?? [],
      );
      return {
        status: 'rejected',
        relativePath,
        strayFiles,
        offendingFiles,
        matchedPatterns,
      };
    }
  }

  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      error: result.stderr || `artifact worker exited with code ${result.exitCode}`,
    };
  }

  // Did the worker actually write the artifact?
  try {
    const s = await stat(absolutePath);
    if (!s.isFile() || s.size === 0) {
      return { status: 'no-output', relativePath, strayCheck };
    }
    const content = await readFile(absolutePath, 'utf8');
    const lines = content.split('\n').length;
    const sizeSummary = `${lines} lines · ${(s.size / 1024).toFixed(1)} KB`;
    return {
      status: 'success',
      artifactPath: absolutePath,
      relativePath,
      sizeSummary,
      strayCheck,
    };
  } catch {
    return { status: 'no-output', relativePath, strayCheck };
  }
}

/**
 * Load a non-code worker skill (researcher/designer/writer) from the
 * installed plugin. Returns empty string if the plugin isn't linked —
 * the prompt falls back to the inline prefix and task description.
 */
export async function loadArtifactWorkerSkill(
  pluginRoot: string,
  workerKind: Exclude<WorkerKind, 'code'>,
): Promise<string> {
  const skillName =
    workerKind === 'research'
      ? 'sleepy-researcher'
      : workerKind === 'design'
        ? 'sleepy-designer'
        : 'sleepy-writer';
  try {
    return await readFile(
      path.join(pluginRoot, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
  } catch {
    return '';
  }
}

/**
 * Map a successful artifact dispatch back to the queue item type used by
 * SLEEPY_QUEUE.md. Keeps the mapping in one place.
 */
export function queueTypeForKind(
  kind: Exclude<WorkerKind, 'code'>,
): 'research' | 'plans' | 'content' {
  if (kind === 'research') return 'research';
  if (kind === 'design') return 'plans';
  return 'content';
}
