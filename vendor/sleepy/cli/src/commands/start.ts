import { createRunLaunchers, resolveSleepyProvider } from '../supervisor/providers.js';
import lockfile from 'proper-lockfile';
import { Command } from 'commander';
import { access, readFile, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { sleepyPaths } from '../paths.js';
import { initSleepyDir } from '../state/init.js';
import { brand } from '../ui/colors.js';
import { printBanner } from '../ui/banner.js';
import {
  writeConfig,
  IntensityLevel as IntensityEnum,
  type SleepyConfig,
} from '../state/config.js';
import { writeBudget } from '../state/budget.js';
import { readRules } from '../state/rules.js';
import { appendQueueItem } from '../state/queue.js';
import { beginRunReport } from '../state/run-report.js';
import { checkCwdSafety } from '../state/cwd-safety.js';
import {
  killAllActiveChildren,
} from '../supervisor/claude-launcher.js';
import { runSupervisor } from '../supervisor/loop.js';
import {
  dispatchWorker,
  loadWorkerSkill,
} from '../supervisor/worker-dispatch.js';
import {
  dispatchArtifactWorker,
  loadArtifactWorkerSkill,
  queueTypeForKind,
} from '../supervisor/artifact-worker.js';
import type { WorkerKind } from '../state/next-action.js';
import { reportAfterRun } from './report.js';
import { extractSummary } from '../report/summary.js';

const PROMPT_PREFIX = `You are being invoked by the sleepy supervisor to run one iteration of an autonomous project-improvement loop. Follow the sleepy-orchestrator instructions below exactly.

IMPORTANT BOUNDARIES:
- DO NOT modify .sleepy/budget.json — the supervisor owns this file and writes to it after you exit.
- DO NOT modify .sleepy/config.json — the supervisor owns this file.
- You may freely write .sleepy/SLEEPY.md, .sleepy/SLEEPY_BACKLOG.md, .sleepy/SLEEPY_MEMORY.md, .sleepy/SLEEPY_QUEUE.md, .sleepy/next-action.json, and anything under .sleepy/artifacts/ or .sleepy/logs/.
- In dry-run mode you must NOT touch any file outside .sleepy/.

When the instructions below refer to "the skill", they are referring to these same instructions — you have already been given them. Proceed with Step 1.

===== sleepy-orchestrator skill =====

`;

export const ORCHESTRATOR_PROMPT = PROMPT_PREFIX + '(skill content is loaded from the plugin at launch time — see sleepy-orchestrator)';

function resolveOrchestratorSkillPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    '..',
    '..',
    '..',
    'plugin',
    'skills',
    'sleepy-orchestrator',
    'SKILL.md',
  );
}

async function buildOrchestratorPrompt(): Promise<string> {
  const skillPath = resolveOrchestratorSkillPath();
  let skillContent: string;
  try {
    skillContent = await readFile(skillPath, 'utf8');
  } catch {
    return ORCHESTRATOR_PROMPT;
  }
  const stripped = skillContent.replace(/^---\n[\s\S]*?\n---\n+/, '');
  return PROMPT_PREFIX + stripped;
}

export interface StartCliOptions {
  dryRun: boolean;
  intensity?: string;
  duration?: string;
  cap?: string;
  maxIterations?: string;
  force?: boolean;
  team?: boolean;
  provider?: string;
  goal?: string;
  runId?: string;
}

function parseDurationToDeadline(spec: string, base: Date): string {
  const m = /^(\d+)\s*([hdm])$/.exec(spec.trim().toLowerCase());
  if (!m) {
    throw new Error(`invalid --duration "${spec}" (expected forms: "48h", "2d", "30m")`);
  }
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('invalid --duration (expected a positive duration)');
  const unit = m[2];
  const ms = unit === 'h' ? n * 3_600_000 : unit === 'd' ? n * 86_400_000 : n * 60_000;
  return new Date(base.getTime() + ms).toISOString();
}

export function buildStartConfig(opts: StartCliOptions, now: Date): SleepyConfig {
  const provider = resolveSleepyProvider(opts);
  if (opts.maxIterations !== undefined && (!Number.isSafeInteger(Number(opts.maxIterations)) || Number(opts.maxIterations) <= 0)) {
    throw new Error('invalid --max-iterations (expected a positive integer)');
  }
  if (opts.team && opts.cap) throw new Error('Sleepy Duo supports --duration, not --cap: combined provider token accounting is not available.');
  if (provider === 'codex' && opts.cap) throw new Error('Codex-only Sleepy supports --duration or --max-iterations, not --cap: Codex token accounting is not available.');
  const intensity = opts.intensity ?? 'medium';
  const parsed = IntensityEnum.safeParse(intensity);
  if (!parsed.success) {
    throw new Error(`invalid --intensity "${intensity}" (expected: low|medium|high|max)`);
  }
  const deadline = opts.duration ? parseDurationToDeadline(opts.duration, now) : undefined;
  const tokenCap = opts.cap ? Number(opts.cap) : undefined;
  if (tokenCap !== undefined && (!Number.isInteger(tokenCap) || tokenCap <= 0)) {
    throw new Error(`invalid --cap "${opts.cap}" (expected positive integer)`);
  }

  const cfg: SleepyConfig = {
    version: 1,
    startedAt: now.toISOString(),
    userIntensity: parsed.data,
    currentIntensity: parsed.data,
    dryRun: opts.dryRun === true,
    windDown: false,
    ...(deadline !== undefined ? { deadline } : {}),
    ...(tokenCap !== undefined ? { tokenCap } : {}),
  };
  return cfg;
}

async function clearStopFlag(projectRoot: string): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  try {
    await unlink(paths.stopFlag);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function ensurePluginInstalled(): Promise<void> {
  const pluginDir = path.join(os.homedir(), '.claude', 'plugins', 'sleepy');
  try {
    await access(pluginDir);
  } catch {
    throw new Error(
      'sleepy plugin is not installed at ~/.claude/plugins/sleepy.\n' +
        'Run `sleepy link-plugin` from the sleepy repo to install it.',
    );
  }
}

export function startCommand(): Command {
  return new Command('start')
    .description('launch a sleepy run')
    .option('--dry-run', 'dry-run mode (orchestrator-only, no worker dispatch)', false)
    .option('--intensity <level>', 'low | medium | high | max', 'medium')
    .option('--duration <spec>', 'duration like 48h / 2d / 30m')
    .option('--cap <tokens>', 'token cap as an integer')
    .option('--max-iterations <n>', 'supervisor loop ceiling (default: 1 dry-run, 10 live)')
    .option('--team', 'Sleepy Duo: Codex implements alongside read-only Opus review')
    .option('--provider <name>', 'single-provider run: opus (default) | codex; applies to planning and every worker')
    .option('--run-id <id>', 'correlate this run with a batch')
    .option('--goal <text>', 'focus for this run')
    .option('--force', 'skip the cwd safety check (for experts)')
    .action(async (opts: StartCliOptions) => {
      const now = new Date();
      const projectRoot = process.cwd();

      if (!opts.force) {
        const safety = checkCwdSafety(projectRoot);
        if (!safety.ok) {
          console.error(`sleepy: ${safety.reason}`);
          console.error(`  (if you really mean it, pass --force)`);
          process.exit(1);
        }
        for (const warning of safety.warnings) {
          console.error(`sleepy: warning — ${warning}`);
        }
      }

      const cfg = buildStartConfig(opts, now);
      const provider = resolveSleepyProvider(opts);

      await initSleepyDir(projectRoot);
      const releaseRunLock = await lockfile.lock(sleepyPaths(projectRoot).root, { retries: 0 });
      let finishRunReport: (() => Promise<void>) | undefined;
      let terminationReason: string | undefined;
      try {
      if (opts.runId) {
        finishRunReport = await beginRunReport(projectRoot, opts.runId);
        console.log(`SLEEPY_RUN_STARTED:${opts.runId}`);
      }
      if (opts.goal?.trim()) await writeFile(path.join(projectRoot, '.sleepy', 'USER_GOALS.md'), opts.goal.trim() + '\n', 'utf8');
      await writeConfig(projectRoot, cfg);
      await writeBudget(projectRoot, {
        version: 1,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        tokensUsed: 0,
        iterations: 0,
        burnSamples: [],
      });
      await clearStopFlag(projectRoot);
      // Clear any stale next-action.json left from a previous crashed run
      // so the loop doesn't try to re-process an old action on restart.
      const { clearNextAction } = await import('../state/next-action.js');
      await clearNextAction(projectRoot);
      if (provider !== 'codex') await ensurePluginInstalled();

      // When the user gave us a duration or token cap, those become the real
      // stop conditions — let iterations run freely until one of them fires
      // (or stuck/failure breakers trip). Otherwise default to a modest ceiling.
      const hasBudgetLimit = cfg.deadline !== undefined || cfg.tokenCap !== undefined;
      const maxIterations = opts.maxIterations
        ? Number(opts.maxIterations)
        : cfg.dryRun
          ? 1
          : hasBudgetLimit
            ? Number.MAX_SAFE_INTEGER
            : 10;

      const { orchestrator: orchestratorLauncher, worker: workerLauncher, artifact: artifactLauncher } =
        createRunLaunchers(provider, sleepyPaths(projectRoot).stopFlag);
      const prompt = await buildOrchestratorPrompt();

      // Codex can use the bundled instructions without a Claude installation.
      const pluginRoot = provider === 'codex'
        ? path.resolve(path.dirname(resolveOrchestratorSkillPath()), '..', '..')
        : path.join(os.homedir(), '.claude', 'plugins', 'sleepy');
      const workerSkill = await loadWorkerSkill(pluginRoot);
      const rules = await readRules(projectRoot);

      const mode = cfg.dryRun ? 'dry-run' : 'live';
      const iterLabel =
        maxIterations === Number.MAX_SAFE_INTEGER
          ? 'unlimited iter'
          : `${maxIterations} iter`;
      const limitLabel = cfg.deadline
        ? ` · until ${cfg.deadline}`
        : cfg.tokenCap
          ? ` · cap ${cfg.tokenCap.toLocaleString('en-US')} tokens`
          : '';
      printBanner({
        subtitle: `${mode} · ${provider === 'duo' ? 'Codex + Opus' : provider === 'opus' ? 'Opus only' : 'Codex only'} · ${iterLabel} · ${cfg.currentIntensity} intensity${limitLabel}`,
      });
      console.log(`  ${brand.sleepy('sleepy:')} project ${brand.meta(projectRoot)}`);
      console.log('');
      console.log(
        `  ${brand.meta('──── output streams: ')}${brand.orchestrator('│ orchestrator')}${brand.meta('   ')}${brand.worker('▸ worker')}${brand.meta(' ────')}`,
      );
      console.log(
        `  ${brand.meta('──── press ')}${brand.header('ESC')}${brand.meta(' or ')}${brand.header('Ctrl+C')}${brand.meta(' to stop ──────────')}`,
      );
      console.log('');

      // Set up ESC / Ctrl+C handler. ESC writes the STOP flag and kills any
      // active Claude child, which makes the next iteration see the flag and
      // wind down cleanly.
      let stopRequested = false;
      let rawModeActive = false;
      if (process.stdin.isTTY) {
        try {
          readline.emitKeypressEvents(process.stdin);
          process.stdin.setRawMode(true);
          process.stdin.resume();
          rawModeActive = true;
          process.stdin.on('keypress', (_str, key) => {
            if (!key) return;
            if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
              if (stopRequested) {
                // Second press — exit immediately
                console.log('');
                console.log(
                  `${brand.sleepy('sleepy:')} ${brand.error('force-quit')} (killing active agents and exiting now)`,
                );
                killAllActiveChildren('SIGKILL');
                process.exit(130);
              }
              stopRequested = true;
              const which = key.name === 'escape' ? 'ESC' : 'Ctrl+C';
              console.log('');
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.error(which)} — stopping after current operation (press again to force-quit)...`,
              );
              // Write the STOP flag so the supervisor winds down on the next iteration
              const paths = sleepyPaths(projectRoot);
              void (async () => {
                try {
                  await mkdir(path.dirname(paths.stopFlag), { recursive: true });
                  await writeFile(
                    paths.stopFlag,
                    new Date().toISOString() + '\n',
                    'utf8',
                  );
                } catch {
                  // best effort
                }
              })();
              // Kill active Claude children (SIGTERM). If a worker is mid-commit
              // it'll finish on the commit line, supervisor sees non-zero exit
              // and the STOP flag then ends the loop.
              killAllActiveChildren('SIGTERM');
            }
          });
        } catch {
          rawModeActive = false;
        }
      }
      const restoreStdin = (): void => {
        if (rawModeActive && process.stdin.isTTY) {
          try {
            process.stdin.setRawMode(false);
          } catch {
            // ignore
          }
          process.stdin.pause();
        }
      };

      const onSignal = () => {
        stopRequested = true;
        void writeFile(sleepyPaths(projectRoot).stopFlag, new Date().toISOString() + '\n').catch((err) => console.error(`sleepy: could not write STOP: ${err.message}`));
        killAllActiveChildren('SIGTERM');
      };
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);
      try {
      const summary = await runSupervisor({
        projectRoot,
        launcher: orchestratorLauncher,
        prompt,
        maxIterations,
        // Omit sleepBetweenMs so the loop reads it from current intensity
        // each iteration — pacing shifts take effect in real time.
        onPacingShift: (from, to, reason) => {
          console.log('');
          console.log(
            `${brand.sleepy('sleepy:')} ${brand.header('pacing')} — shifted ${brand.header(from)} → ${brand.header(to)} ${brand.meta('(' + reason + ')')}`,
          );
          console.log('');
        },
        onLimitHit: (reason) => {
          console.log('');
          console.log(
            `${brand.sleepy('sleepy:')} ${brand.success('✓')} ${brand.header(reason)} reached — winding down`,
          );
          console.log('');
        },
        onNextAction: async (action) => {
          console.log('');
          if (action.kind !== 'dispatch-worker') {
            console.log(
              `${brand.sleepy('sleepy:')} orchestrator chose ${brand.header(action.kind)} — skipping worker dispatch`,
            );
            if (action.kind === 'idle' || action.kind === 'wind-down') {
              console.log(`         ${brand.meta('reason: ' + action.reason)}`);
            }
            return;
          }
          // Wrap the entire worker dispatch in try/catch so a crashed Claude
          // child, timeout, OOM, or any other exception counts as a failed
          // iteration instead of killing the supervisor loop.
          try {
          const workerKind: WorkerKind = action.worker_kind ?? 'code';
          console.log(
            `${brand.sleepy('sleepy:')} orchestrator picked backlog ${brand.header('#' + action.backlogItemNumber)}: ${brand.header(action.title)}`,
          );
          console.log(`         ${brand.meta('kind:       ')}${brand.header(workerKind)}`);
          console.log(`         ${brand.meta('category:   ')}${action.category}`);
          console.log(`         ${brand.meta('scope:      ')}${action.scope}`);
          console.log(`         ${brand.meta('reasoning:  ')}${action.reasoning}`);
          console.log('');

          if (workerKind === 'code') {
            console.log(
              `${brand.sleepy('sleepy:')} creating worktree on branch ${brand.header('sleepy/' + action.slug)}...`,
            );
            console.log('');
            const result = await dispatchWorker({
              repoRoot: projectRoot,
              launcher: workerLauncher,
              action,
              rulesMdContent: rules.rawContent,
              skillContent: workerSkill,
              denyPaths: rules.denyPaths,
            });
            console.log('');
            if (result.status === 'success') {
              await appendQueueItem(projectRoot, {
                type: 'code',
                summary: action.title,
                artifact: { kind: 'branch', name: result.branch },
                size: result.sizeSummary,
                addedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
              });
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.success('✓')} worker produced ${brand.header(result.branch)} ${brand.meta('(' + result.sizeSummary + ')')}`,
              );
              console.log(`         ${brand.meta('review it with: sleepy why <#>')}`);
            } else if (result.status === 'no-changes') {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.meta('∅')} worker produced no changes on ${result.branch}`,
              );
              return 'unproductive';
            } else if (result.status === 'rejected') {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.error('✗')} worker rejected — touched denied paths ${brand.meta('(' + result.matchedPatterns.join(', ') + ')')}: ${result.offendingFiles.join(', ')}`,
              );
              throw new Error('Worker touched denied paths');
            } else {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.error('✗')} worker failed — ${result.error}`,
              );
              throw new Error(result.error);
            }
          } else {
            // Artifact worker: research, design, or content
            const kindLabel =
              workerKind === 'research'
                ? 'research report'
                : workerKind === 'design'
                  ? 'design spec'
                  : 'content draft';
            console.log(
              `${brand.sleepy('sleepy:')} dispatching ${brand.header(workerKind)} worker for ${kindLabel}...`,
            );
            console.log('');
            const artifactSkill = await loadArtifactWorkerSkill(pluginRoot, workerKind);
            const artifactResult = await dispatchArtifactWorker({
              projectRoot,
              launcher: artifactLauncher,
              action,
              workerKind,
              rulesMdContent: rules.rawContent,
              skillContent: artifactSkill,
              denyPaths: rules.denyPaths,
            });
            console.log('');
            if (artifactResult.status === 'rejected') {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.error('✗')} ${workerKind} worker rejected — wrote outside ${artifactResult.relativePath}: ${artifactResult.strayFiles.join(', ')}`,
              );
              if (artifactResult.offendingFiles.length > 0) {
                console.log(
                  `         ${brand.error('touched denied paths')} ${brand.meta('(' + artifactResult.matchedPatterns.join(', ') + ')')}: ${artifactResult.offendingFiles.join(', ')}`,
                );
              }
              console.log(
                `         ${brand.meta('these changes were left in your working tree — review them with git status / git log')}`,
              );
              throw new Error(
                artifactResult.offendingFiles.length > 0
                  ? 'Artifact worker touched denied paths'
                  : 'Artifact worker wrote outside its artifact path',
              );
            }
            if (artifactResult.status !== 'failed' && artifactResult.strayCheck === 'unavailable') {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.meta('not a git repo — could not verify the ' + workerKind + ' worker stayed read-only')}`,
              );
            }
            if (artifactResult.status === 'success') {
              await appendQueueItem(projectRoot, {
                type: queueTypeForKind(workerKind),
                summary: action.title,
                artifact: {
                  kind: 'file',
                  path: artifactResult.relativePath,
                },
                size: artifactResult.sizeSummary,
                addedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
              });
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.success('✓')} ${workerKind} worker produced ${brand.header(artifactResult.relativePath)} ${brand.meta('(' + artifactResult.sizeSummary + ')')}`,
              );
              console.log(`         ${brand.meta('review it with: sleepy why <#>')}`);
              try {
                const written = await readFile(artifactResult.artifactPath, 'utf8');
                if (!extractSummary(written).found) {
                  console.log(`         ${brand.meta('no TL;DR section — the report will show the opening paragraph instead')}`);
                }
              } catch { /* the warning is advisory; a read failure must not turn a success into a crash */ }
            } else if (artifactResult.status === 'no-output') {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.meta('∅')} ${workerKind} worker produced no output (expected ${artifactResult.relativePath})`,
              );
              return 'unproductive';
            } else {
              console.log(
                `${brand.sleepy('sleepy:')} ${brand.error('✗')} ${workerKind} worker failed — ${artifactResult.error}`,
              );
              throw new Error(artifactResult.error);
            }
          }
          console.log('');
          } catch (err) {
            console.log('');
            console.log(
              `${brand.sleepy('sleepy:')} ${brand.error('✗ worker crashed')} — ${(err as Error).message ?? 'unknown error'}`,
            );
            console.log(
              `         ${brand.meta('the supervisor will continue to the next iteration')}`,
            );
            console.log('');
            throw err;
          }
        },
      });
      terminationReason = summary.terminationReason;
      console.log('');
      const terminationOk =
        summary.terminationReason === 'max-iterations' ||
        summary.terminationReason === 'stopped' ||
        summary.terminationReason === 'deadline' ||
        summary.terminationReason === 'token-cap';
      const reasonColor = terminationOk ? brand.success : brand.error;
      if (!terminationOk) process.exitCode = 1;
      console.log(
        `${brand.sleepy('sleepy:')} finished — ${brand.header(String(summary.iterationsRun))} iteration(s), ${brand.success(String(summary.successfulIterations) + ' ok')}, ${brand.error(String(summary.failedIterations) + ' failed')} ${brand.meta('(' + reasonColor(summary.terminationReason) + ')')}`,
      );
      console.log('');
      console.log(brand.meta('  read what this run produced:'));
      console.log(brand.meta('    sleepy report --open'));
      console.log('');

      } finally { process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal); restoreStdin(); }
      } finally {
        try {
          try { await finishRunReport?.(); }
          finally { await reportAfterRun(projectRoot, opts.runId, terminationReason); }
        } finally { await releaseRunLock(); }
      }
    });
}
