import type { IntensityLevel } from '../state/config.js';
export type { IntensityLevel };

export interface IntensityBundle {
  targetIterationMs: number;
  iterationTokenCap: number;
  sleepBetweenMs: number;
  maxParallelWorkers: number;
  riskTolerance: 'cautious' | 'normal' | 'aggressive';
  stopOnUncertainty: 'yes' | 'sometimes' | 'rarely' | 'never';
  workerAmbition: 'small' | 'medium' | 'large';
}

export const INTENSITY_BUNDLES: Record<IntensityLevel, IntensityBundle> = {
  low: {
    targetIterationMs: 5 * 60_000,
    iterationTokenCap: 30_000,
    sleepBetweenMs: 120_000,
    maxParallelWorkers: 1,
    riskTolerance: 'cautious',
    stopOnUncertainty: 'yes',
    workerAmbition: 'small',
  },
  medium: {
    targetIterationMs: 15 * 60_000,
    iterationTokenCap: 80_000,
    sleepBetweenMs: 60_000,
    maxParallelWorkers: 1,
    riskTolerance: 'normal',
    stopOnUncertainty: 'sometimes',
    workerAmbition: 'medium',
  },
  high: {
    targetIterationMs: 30 * 60_000,
    iterationTokenCap: 150_000,
    sleepBetweenMs: 30_000,
    maxParallelWorkers: 2,
    riskTolerance: 'normal',
    stopOnUncertainty: 'rarely',
    workerAmbition: 'large',
  },
  max: {
    targetIterationMs: 60 * 60_000,
    iterationTokenCap: 300_000,
    sleepBetweenMs: 10_000,
    maxParallelWorkers: 3,
    riskTolerance: 'aggressive',
    stopOnUncertainty: 'never',
    workerAmbition: 'large',
  },
};

const ORDER: readonly IntensityLevel[] = ['low', 'medium', 'high', 'max'];

export function intensityLevelIndex(level: IntensityLevel): number {
  return ORDER.indexOf(level);
}

export function stepDown(level: IntensityLevel): IntensityLevel {
  const i = intensityLevelIndex(level);
  return ORDER[Math.max(0, i - 1)]!;
}

export function stepUp(level: IntensityLevel): IntensityLevel {
  const i = intensityLevelIndex(level);
  return ORDER[Math.min(ORDER.length - 1, i + 1)]!;
}

export interface PacingInput {
  now: Date;
  currentIntensity: IntensityLevel;
  userIntensity: IntensityLevel;
  startedAt: Date;
  tokensUsed: number;
  deadline?: Date;
  tokenCap?: number;
}

export interface PacingDecision {
  nextIntensity: IntensityLevel;
  reason: string;
}

const MIN_ELAPSED_MS_FOR_PROJECTION = 60_000;

export function decidePacing(input: PacingInput): PacingDecision {
  const elapsedMs = input.now.getTime() - input.startedAt.getTime();

  if (elapsedMs < MIN_ELAPSED_MS_FOR_PROJECTION) {
    return { nextIntensity: input.currentIntensity, reason: 'warming up' };
  }

  if (!input.deadline || input.tokenCap === undefined) {
    return { nextIntensity: input.currentIntensity, reason: 'hold (no deadline+cap)' };
  }

  const remainingMs = input.deadline.getTime() - input.now.getTime();
  if (remainingMs <= 0) {
    return { nextIntensity: stepDown(input.currentIntensity), reason: 'past deadline' };
  }

  const burnRate = input.tokensUsed / elapsedMs; // tokens / ms
  const projectedTotalBurn = input.tokensUsed + burnRate * remainingMs;
  const remainingTokens = input.tokenCap - input.tokensUsed;
  const projectedFutureBurn = burnRate * remainingMs;

  if (projectedFutureBurn > remainingTokens) {
    return {
      nextIntensity: stepDown(input.currentIntensity),
      reason: `downshift: projected ${Math.round(projectedTotalBurn).toLocaleString()} tokens exceeds cap`,
    };
  }

  if (projectedFutureBurn < remainingTokens * 0.5) {
    const candidate = stepUp(input.currentIntensity);
    const capped =
      intensityLevelIndex(candidate) > intensityLevelIndex(input.userIntensity)
        ? input.userIntensity
        : candidate;
    if (capped !== input.currentIntensity) {
      return { nextIntensity: capped, reason: 'upshift: under-spending budget' };
    }
  }

  return { nextIntensity: input.currentIntensity, reason: 'on pace' };
}
