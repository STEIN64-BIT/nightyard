import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeLauncher } from './launcher.js';
import type { NextAction } from '../state/next-action.js';
import { createWorktree, removeWorktree, hasCommitsOnBranch } from './worktree.js';
import { checkBranchDiff } from './diff-check.js';

const execFile = promisify(execFileCb);

const WORKER_PROMPT_PREFIX = `You are a sleepy worker. You have been dispatched in an ISOLATED git worktree on a new branch. You must do ONE task, commit cleanly, write SLEEPY_ARTIFACT.md at the repo root, and exit.

===== TASK =====
`;

const WORKER_RULES_HEADER = `
===== PROJECT RULES (from .sleepy/SLEEPY_RULES.md in the main repo) =====
`;

const WORKER_SKILL_HEADER = `
===== sleepy-worker skill =====
`;

export interface BuildWorkerPromptInput {
  action: Extract<NextAction, { kind: 'dispatch-worker' }>;
  rulesMdContent: string;
  skillContent: string;
}

export function buildWorkerPrompt(input: BuildWorkerPromptInput): string {
  const task = [
    `Title: ${input.action.title}`,
    `Category: ${input.action.category}`,
    `Scope: ${input.action.scope}`,
    `Reasoning from the orchestrator: ${input.action.reasoning}`,
  ].join('\n');
  const rules = input.rulesMdContent.trim() || '(no rules file)';
  const skill = input.skillContent.replace(/^---\n[\s\S]*?\n---\n+/, '');
  return (
    WORKER_PROMPT_PREFIX +
    task +
    '\n' +
    WORKER_RULES_HEADER +
    rules +
    '\n' +
    WORKER_SKILL_HEADER +
    skill
  );
}

export type DispatchResult =
  | {
      status: 'success';
      branch: string;
      artifactText: string;
      sizeSummary: string;
      changedFiles: string[];
    }
  | { status: 'no-changes'; branch: string }
  | {
      status: 'rejected';
      branch: string;
      offendingFiles: string[];
      matchedPatterns: string[];
    }
  | { status: 'failed'; error: string };

export interface DispatchWorkerInput {
  repoRoot: string;
  launcher: ClaudeLauncher;
  action: Extract<NextAction, { kind: 'dispatch-worker' }>;
  rulesMdContent: string;
  skillContent: string;
  /**
   * Parsed "Do not touch" patterns from SLEEPY_RULES.md (see readRules).
   * Required so a caller cannot silently skip the deny-path check; pass []
   * explicitly when there are no rules.
   */
  denyPaths: string[];
}

async function computeDiffStats(
  repoRoot: string,
  branch: string,
): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      ['diff', '--shortstat', `HEAD...${branch}`],
      { cwd: repoRoot },
    );
    const trimmed = stdout.trim();
    const filesMatch = /(\d+) files? changed/.exec(trimmed);
    const insMatch = /(\d+) insertions?\(\+\)/.exec(trimmed);
    const delMatch = /(\d+) deletions?\(-\)/.exec(trimmed);
    const files = filesMatch ? filesMatch[1] : '0';
    const ins = insMatch ? insMatch[1] : '0';
    const del = delMatch ? delMatch[1] : '0';
    return `+${ins}/-${del} · ${files} files`;
  } catch {
    return '+?/-? · ? files';
  }
}

async function readArtifactFromBranch(
  repoRoot: string,
  branch: string,
): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      ['show', `${branch}:SLEEPY_ARTIFACT.md`],
      { cwd: repoRoot },
    );
    return stdout;
  } catch {
    return '(no SLEEPY_ARTIFACT.md committed)';
  }
}

export async function dispatchWorker(
  input: DispatchWorkerInput,
): Promise<DispatchResult> {
  const branch = `sleepy/${input.action.slug}`;
  const wt = await createWorktree({ repoRoot: input.repoRoot, branch });

  try {
    const prompt = buildWorkerPrompt({
      action: input.action,
      rulesMdContent: input.rulesMdContent,
      skillContent: input.skillContent,
    });
    const launchResult = await input.launcher.run({ prompt, cwd: wt.path });

    if (launchResult.exitCode !== 0) {
      return {
        status: 'failed',
        error: launchResult.stderr || `worker exited with code ${launchResult.exitCode}`,
      };
    }

    const hasCommits = await hasCommitsOnBranch(input.repoRoot, branch);
    if (!hasCommits) {
      return { status: 'no-changes', branch };
    }

    // Rules check — reject if any changed file is on the deny list
    const diffResult = await checkBranchDiff(input.repoRoot, branch, input.denyPaths);
    if (diffResult.status === 'denied') {
      // Worktree must be removed before we can delete the branch it holds
      await removeWorktree(input.repoRoot, wt);
      try {
        await execFile('git', ['branch', '-D', branch], { cwd: input.repoRoot });
      } catch {
        // best effort
      }
      return {
        status: 'rejected',
        branch,
        offendingFiles: diffResult.offendingFiles,
        matchedPatterns: diffResult.matchedPatterns,
      };
    }

    const [sizeSummary, artifactText] = await Promise.all([
      computeDiffStats(input.repoRoot, branch),
      readArtifactFromBranch(input.repoRoot, branch),
    ]);

    return {
      status: 'success',
      branch,
      artifactText,
      sizeSummary,
      changedFiles: diffResult.changedFiles,
    };
  } finally {
    await removeWorktree(input.repoRoot, wt);
  }
}

/**
 * Read the worker SKILL.md from the installed plugin. Returns empty
 * string if the plugin isn't linked — the worker prompt still gets the
 * built-in prefix from buildWorkerPrompt.
 */
export async function loadWorkerSkill(pluginRoot: string): Promise<string> {
  try {
    return await readFile(
      path.join(pluginRoot, 'skills', 'sleepy-worker', 'SKILL.md'),
      'utf8',
    );
  } catch {
    return '';
  }
}
