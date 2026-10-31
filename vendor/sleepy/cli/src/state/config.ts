import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sleepyPaths } from '../paths.js';

export const IntensityLevel = z.enum(['low', 'medium', 'high', 'max']);
export type IntensityLevel = z.infer<typeof IntensityLevel>;

const SleepyConfigSchema = z.object({
  version: z.literal(1),
  startedAt: z.string().datetime(),
  userIntensity: IntensityLevel,
  currentIntensity: IntensityLevel,
  deadline: z.string().datetime().optional(),
  tokenCap: z.number().int().positive().optional(),
  dryRun: z.boolean(),
  windDown: z.boolean(),
});

export type SleepyConfig = z.infer<typeof SleepyConfigSchema>;

export async function writeConfig(projectRoot: string, cfg: SleepyConfig): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  await mkdir(path.dirname(paths.configJson), { recursive: true });
  const validated = SleepyConfigSchema.parse(cfg);
  await writeFile(paths.configJson, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

export async function readConfig(projectRoot: string): Promise<SleepyConfig | null> {
  const paths = sleepyPaths(projectRoot);
  let raw: string;
  try {
    raw = await readFile(paths.configJson, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return SleepyConfigSchema.parse(JSON.parse(raw));
}
