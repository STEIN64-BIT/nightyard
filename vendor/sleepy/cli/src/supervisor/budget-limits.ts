import type { SleepyConfig } from '../state/config.js';
import type { SleepyBudget } from '../state/budget.js';

export type BudgetLimitReason = 'deadline' | 'token-cap';

export type BudgetLimitResult =
  | { status: 'continue' }
  | { status: 'terminate'; reason: BudgetLimitReason };

/**
 * Pure function — given the current run config, the latest budget snapshot,
 * and the current time, decide whether the supervisor should continue
 * looping or terminate. Deadline takes precedence over token-cap when both
 * are set and both are triggered.
 */
export function enforceBudgetLimits(
  cfg: SleepyConfig,
  budget: SleepyBudget | null,
  now: Date,
): BudgetLimitResult {
  if (cfg.deadline) {
    const deadline = new Date(cfg.deadline);
    if (now.getTime() >= deadline.getTime()) {
      return { status: 'terminate', reason: 'deadline' };
    }
  }
  if (cfg.tokenCap !== undefined && budget && budget.tokensUsed >= cfg.tokenCap) {
    return { status: 'terminate', reason: 'token-cap' };
  }
  return { status: 'continue' };
}
