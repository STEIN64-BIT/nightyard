import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { sleepyPaths } from '../paths.js';

// Durable, user-authored settings. They live outside .sleepy/config.json,
// which `sleepy start` rewrites on every run. Unknown keys pass through so
// later phases can add their own without breaking older CLIs.
const SettingsSchema = z
  .object({
    report: z
      .object({
        publishCommand: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SleepySettings = z.infer<typeof SettingsSchema>;

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'sleepy', 'settings.json');
}

async function readOne(file: string): Promise<SleepySettings | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  const result = SettingsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? issue.path.join('.') : 'settings';
    throw new Error(`Could not read ${file}: ${where} — ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}

export async function readSettings(
  projectRoot: string,
  opts: { globalPath?: string } = {},
): Promise<SleepySettings> {
  const global = (await readOne(opts.globalPath ?? globalSettingsPath())) ?? {};
  const project = (await readOne(sleepyPaths(projectRoot).settingsJson)) ?? {};
  const report = global.report || project.report ? { ...global.report, ...project.report } : undefined;
  return { ...global, ...project, ...(report ? { report } : {}) };
}
