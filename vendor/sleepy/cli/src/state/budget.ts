import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sleepyPaths } from '../paths.js';

const BurnSampleSchema = z.object({
  at: z.string().datetime(),
  tokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

const SleepyBudgetSchema = z.object({
  version: z.literal(1),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tokensUsed: z.number().int().nonnegative(),
  iterations: z.number().int().nonnegative(),
  burnSamples: z.array(BurnSampleSchema),
});

export type BurnSample = z.infer<typeof BurnSampleSchema>;
export type SleepyBudget = z.infer<typeof SleepyBudgetSchema>;

const MAX_BURN_SAMPLES = 60;

export async function writeBudget(projectRoot: string, b: SleepyBudget): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  await mkdir(path.dirname(paths.budgetJson), { recursive: true });
  const validated = SleepyBudgetSchema.parse(b);
  const tmp = `${paths.budgetJson}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  await rename(tmp, paths.budgetJson);
}

export async function readBudget(projectRoot: string): Promise<SleepyBudget | null> {
  const paths = sleepyPaths(projectRoot);
  let raw: string;
  try {
    raw = await readFile(paths.budgetJson, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return SleepyBudgetSchema.parse(JSON.parse(raw));
}

export interface RecordTokensInput {
  tokens: number;
  iterationDeltaMs: number;
  at: Date;
}

export async function recordTokens(
  projectRoot: string,
  input: RecordTokensInput,
): Promise<void> {
  const current = await readBudget(projectRoot);
  if (!current) {
    throw new Error('recordTokens called before budget was initialized');
  }
  const nextSamples = [
    ...current.burnSamples,
    {
      at: input.at.toISOString(),
      tokens: input.tokens,
      durationMs: input.iterationDeltaMs,
    },
  ].slice(-MAX_BURN_SAMPLES);

  const next: SleepyBudget = {
    ...current,
    tokensUsed: current.tokensUsed + input.tokens,
    iterations: current.iterations + 1,
    updatedAt: input.at.toISOString(),
    burnSamples: nextSamples,
  };
  await writeBudget(projectRoot, next);
}
