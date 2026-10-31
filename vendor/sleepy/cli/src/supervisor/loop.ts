import { setTimeout as sleep } from 'node:timers/promises';
import { type ClaudeLauncher } from './launcher.js';
import { runOneIteration, requestedStop, type NextActionHandler } from './iteration.js';
import { enforceBudgetLimits } from './budget-limits.js';
import { readConfig, writeConfig, type SleepyConfig } from '../state/config.js';
import { readBudget } from '../state/budget.js';
import {
  INTENSITY_BUNDLES,
  decidePacing,
} from '../pacing/intensity.js';

export type TerminationReason =
  | 'max-iterations'
  | 'stopped'
  | 'panicked'
  | 'consecutive-failures'
  | 'stuck'
  | 'deadline'
  | 'token-cap';

export interface SupervisorSummary {
  iterationsRun: number;
  successfulIterations: number;
  failedIterations: number;
  terminationReason: TerminationReason;
}

export interface RunSupervisorInput {
  projectRoot: string;
  launcher: ClaudeLauncher;
  prompt: string;
  maxIterations: number;
  /**
   * Base sleep between iterations. If omitted, the loop reads the sleep
   * interval from the current intensity bundle each iteration so pacing
   * shifts take effect in real time.
   */
  sleepBetweenMs?: number;
  maxConsecutiveFailures?: number;
  maxConsecutiveUnproductive?: number;
  onNextAction?: NextActionHandler;
  /**
   * Hook called whenever pacing shifts the current intensity to a new
   * level. Used by the CLI to print a status line.
   */
  onPacingShift?: (
    from: SleepyConfig['currentIntensity'],
    to: SleepyConfig['currentIntensity'],
    reason: string,
  ) => void;
  /**
   * Hook called when a budget limit (deadline or token-cap) is hit.
   * Used by the CLI to print a status line before the loop terminates.
   */
  onLimitHit?: (reason: 'deadline' | 'token-cap') => void;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE = 3;

export async function runSupervisor(
  input: RunSupervisorInput,
): Promise<SupervisorSummary> {
  const maxConsecutiveFailures =
    input.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const maxConsecutiveUnproductive =
    input.maxConsecutiveUnproductive ?? DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE;

  let iterationsRun = 0;
  let successfulIterations = 0;
  let failedIterations = 0;
  let consecutiveFailures = 0;
  let consecutiveUnproductive = 0;
  let terminationReason: TerminationReason = 'max-iterations';

  for (let i = 0; i < input.maxIterations; i++) {
    // Re-read config each iteration so pacing shifts take effect.
    const cfg = await readConfig(input.projectRoot);
    if (!cfg) {
      throw new Error(
        'runSupervisor: .sleepy/config.json not found. Call initSleepyDir + writeConfig before runSupervisor.',
      );
    }

    // Budget limit check (deadline / token-cap)
    const budget = await readBudget(input.projectRoot);
    const limitCheck = enforceBudgetLimits(cfg, budget, new Date());
    if (limitCheck.status === 'terminate') {
      terminationReason = limitCheck.reason;
      if (input.onLimitHit) input.onLimitHit(limitCheck.reason);
      break;
    }

    const outcome = await runOneIteration({
      projectRoot: input.projectRoot,
      launcher: input.launcher,
      prompt: input.prompt,
      now: new Date(),
      ...(input.onNextAction !== undefined ? { onNextAction: input.onNextAction } : {}),
    });

    if (outcome.status === 'stopped' || outcome.status === 'panicked') {
      terminationReason = outcome.status === 'stopped' ? 'stopped' : 'panicked';
      break;
    }

    iterationsRun += 1;

    if (outcome.status === 'ok') {
      successfulIterations += 1;
      consecutiveFailures = 0;

      const productive =
        outcome.actionHandled !== undefined &&
        outcome.actionHandled.kind !== 'idle';
      if (productive) {
        consecutiveUnproductive = 0;
      } else {
        consecutiveUnproductive += 1;
        if (consecutiveUnproductive >= maxConsecutiveUnproductive) {
          terminationReason = 'stuck';
          break;
        }
      }
    } else {
      failedIterations += 1;
      consecutiveFailures += 1;
      consecutiveUnproductive = 0;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        terminationReason = 'consecutive-failures';
        break;
      }
    }

    // Pacing decision — adjust intensity if burn rate is off pace.
    // Only meaningful when both deadline and tokenCap are set.
    if (cfg.deadline && cfg.tokenCap !== undefined) {
      const postBudget = await readBudget(input.projectRoot);
      if (postBudget) {
        const decision = decidePacing({
          now: new Date(),
          currentIntensity: cfg.currentIntensity,
          userIntensity: cfg.userIntensity,
          startedAt: new Date(cfg.startedAt),
          deadline: new Date(cfg.deadline),
          tokenCap: cfg.tokenCap,
          tokensUsed: postBudget.tokensUsed,
        });
        if (decision.nextIntensity !== cfg.currentIntensity) {
          await writeConfig(input.projectRoot, {
            ...cfg,
            currentIntensity: decision.nextIntensity,
          });
          if (input.onPacingShift) {
            input.onPacingShift(
              cfg.currentIntensity,
              decision.nextIntensity,
              decision.reason,
            );
          }
        }
      }
    }

    // Sleep using the (possibly just-adjusted) current intensity, or the
    // explicit override when provided.
    const isLast = i === input.maxIterations - 1;
    if (!isLast) {
      let sleepMs: number;
      if (input.sleepBetweenMs !== undefined) {
        sleepMs = input.sleepBetweenMs;
      } else {
        // Re-read cfg because pacing may have rewritten it
        const freshCfg = await readConfig(input.projectRoot);
        const intensity = freshCfg?.currentIntensity ?? cfg.currentIntensity;
        sleepMs = INTENSITY_BUNDLES[intensity].sleepBetweenMs;
      }
      // Check stop files while pacing, so Stop responds within half a second
      // instead of leaving the CLI asleep for up to two minutes.
      const wakeAt = Math.min(Date.now() + sleepMs, cfg.deadline ? Date.parse(cfg.deadline) : Infinity);
      while (Date.now() < wakeAt) {
        const stop = await requestedStop(input.projectRoot);
        if (stop) {
          return { iterationsRun, successfulIterations, failedIterations, terminationReason: stop };
        }
        await sleep(Math.min(500, Math.max(0, wakeAt - Date.now())));
      }
    }
  }

  return {
    iterationsRun,
    successfulIterations,
    failedIterations,
    terminationReason,
  };
}
