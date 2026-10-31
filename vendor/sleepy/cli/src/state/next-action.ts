import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sleepyPaths } from '../paths.js';

export const WorkerKind = z.enum(['code', 'research', 'design', 'content']);
export type WorkerKind = z.infer<typeof WorkerKind>;

const DispatchWorkerSchema = z.object({
  version: z.literal(1),
  kind: z.literal('dispatch-worker'),
  /**
   * Which kind of worker to dispatch:
   *   - 'code'     → isolated git worktree on sleepy/<slug>; produces a branch
   *   - 'research' → reads project + web, writes .sleepy/artifacts/research/<slug>.md
   *   - 'design'   → brainstorms / specs a feature, writes .sleepy/artifacts/plans/<slug>.md
   *   - 'content'  → writes marketing/docs drafts to .sleepy/artifacts/content/<slug>.md
   *
   * Defaults to 'code' when the orchestrator omits it (backwards compat).
   */
  worker_kind: WorkerKind.optional(),
  slug: z.string().min(1).max(80),
  backlogItemNumber: z.number().int().positive(),
  title: z.string().min(1),
  // Accept any string Claude writes as a category — the orchestrator invents
  // new categories freely and we don't want a schema mismatch to crash the
  // supervisor. The category is informational, not load-bearing.
  category: z.string().min(1),
  scope: z.string(),
  reasoning: z.string(),
});

const IdleSchema = z.object({
  version: z.literal(1),
  kind: z.literal('idle'),
  reason: z.string(),
});

const WindDownSchema = z.object({
  version: z.literal(1),
  kind: z.literal('wind-down'),
  reason: z.string(),
});

export const NextActionSchema = z.discriminatedUnion('kind', [
  DispatchWorkerSchema,
  IdleSchema,
  WindDownSchema,
]);

export type NextAction = z.infer<typeof NextActionSchema>;

export async function writeNextAction(
  projectRoot: string,
  action: NextAction,
): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  await mkdir(path.dirname(paths.nextActionJson), { recursive: true });
  const validated = NextActionSchema.parse(action);
  await writeFile(
    paths.nextActionJson,
    JSON.stringify(validated, null, 2) + '\n',
    'utf8',
  );
}

export async function readNextAction(
  projectRoot: string,
): Promise<NextAction | null> {
  const paths = sleepyPaths(projectRoot);
  let raw: string;
  try {
    raw = await readFile(paths.nextActionJson, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return NextActionSchema.parse(JSON.parse(raw));
}

export async function clearNextAction(projectRoot: string): Promise<void> {
  const paths = sleepyPaths(projectRoot);
  try {
    await unlink(paths.nextActionJson);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
