import { Command } from 'commander';
import { readFile, rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { checkCwdSafety } from '../state/cwd-safety.js';
import { brand } from '../ui/colors.js';

const PlannerCandidateSchema = z.object({
  path: z.string(),
  name: z.string(),
  why: z.string(),
});

export const PlannerResultSchema = z.object({
  path: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  duration_iso: z.string().nullable().optional(),
  duration_spec: z.string().nullable().optional(),
  intensity: z.enum(['low', 'medium', 'high', 'max']).nullable().optional(),
  focus_hint: z.string().nullable().optional(),
  scope_hint: z.string().nullable().optional(),
  user_goals_md: z.string().nullable().optional(),
  token_cap: z.number().int().positive().nullable().optional(),
  ambiguities: z.array(z.string()).optional(),
  candidates: z.array(PlannerCandidateSchema).optional(),
});

export type PlannerResult = z.infer<typeof PlannerResultSchema>;

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}
function err<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

export function parsePlannerResult(raw: string): ParseResult<PlannerResult> {
  const cleaned = raw.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return err('planner result is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return err(`planner result is not valid JSON: ${(e as Error).message}`);
  }
  const result = PlannerResultSchema.safeParse(parsed);
  if (!result.success) {
    return err(`planner result failed schema validation: ${result.error.message}`);
  }
  return ok(result.data);
}

export async function readPlannerResultFile(
  cwd: string,
): Promise<ParseResult<PlannerResult>> {
  const file = path.join(cwd, '.sleepy-planner-result.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return err('planner did not write .sleepy-planner-result.json');
    }
    return err(`failed to read planner result: ${(e as Error).message}`);
  }
  return parsePlannerResult(raw);
}

const PLANNER_PREFIX = `You are the sleepy planner. The sleepy CLI has launched you to turn a user's natural-language request into a complete run plan — project path plus optional duration, intensity, focus, and user goals.

You are strictly read-only. Your final output is a single JSON file at .sleepy-planner-result.json in your current working directory.

`;

export interface BuildPlannerPromptInput {
  description: string;
  skillContent: string;
  now: Date;
}

export function buildPlannerPrompt(input: BuildPlannerPromptInput): string {
  const stripped = input.skillContent.replace(/^---\n[\s\S]*?\n---\n+/, '');
  const nowIso = input.now.toISOString();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    PLANNER_PREFIX +
    `Current time: ${nowIso}\n` +
    `Current user timezone: ${tz}\n` +
    `User's request: "${input.description}"\n\n` +
    '===== sleepy-planner skill =====\n\n' +
    stripped
  );
}

function resolvePlannerSkillPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    '..',
    '..',
    '..',
    'plugin',
    'skills',
    'sleepy-planner',
    'SKILL.md',
  );
}

async function loadPlannerSkill(): Promise<string> {
  try {
    return await readFile(resolvePlannerSkillPath(), 'utf8');
  } catch {
    return '';
  }
}

export function validatePlannerPath(
  p: string,
): { ok: true } | { ok: false; reason: string } {
  const abs = path.resolve(p);
  const safety = checkCwdSafety(abs);
  if (!safety.ok) return { ok: false, reason: safety.reason };
  if (!existsSync(abs)) return { ok: false, reason: `path does not exist: ${abs}` };
  try {
    const s = statSync(abs);
    if (!s.isDirectory()) return { ok: false, reason: `path is not a directory: ${abs}` };
  } catch (e) {
    return { ok: false, reason: `cannot stat ${abs}: ${(e as Error).message}` };
  }
  return { ok: true };
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function runPlannerViaClaude(promptText: string): Promise<{
  exitCode: number;
  cwd: string;
  stdout: string;
  stderr: string;
}> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'sleepy-planner-'));
  let stdout = '';
  let stderr = '';
  const exitCode: number = await new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', promptText, '--dangerously-skip-permissions'],
      {
        cwd: scratchDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  return { exitCode, cwd: scratchDir, stdout, stderr };
}

async function writeUserGoalsFile(
  projectRoot: string,
  goalsMd: string,
): Promise<void> {
  const sleepyDir = path.join(projectRoot, '.sleepy');
  await mkdir(sleepyDir, { recursive: true });
  await writeFile(path.join(sleepyDir, 'USER_GOALS.md'), goalsMd, 'utf8');
}

export function durationFromIso(isoDeadline: string, now: Date): string | null {
  const deadline = new Date(isoDeadline);
  if (isNaN(deadline.getTime())) return null;
  const ms = deadline.getTime() - now.getTime();
  if (ms <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round(ms / 3_600_000);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.round(totalHours / 24)}d`;
}

export function goCommand(): Command {
  return new Command('go')
    .description(
      'natural-language entry point — plan and launch a sleepy run from plain English',
    )
    .argument(
      '<description...>',
      'describe what you want to work on (no quotes needed). Can include duration, intensity, and focus hints.',
    )
    .option('--dry-run', 'preview the backlog only, no workers dispatched', false)
    .option('--yes', 'skip the confirmation prompt (dangerous)', false)
    .action(
      async (
        descriptionParts: string[],
        opts: { dryRun?: boolean; yes?: boolean },
      ) => {
        const description = descriptionParts.join(' ').trim();
        if (!description) {
          console.error(`${brand.sleepy('sleepy:')} description is required. Examples:`);
          console.error('  sleepy go my recommender project');
          console.error('  sleepy go loop until tomorrow morning on the project-b project');
          console.error('  sleepy go run for 2 hours on project-a, focus on test coverage');
          process.exit(2);
        }
        console.log('');
        console.log(
          `${brand.sleepy('sleepy:')} asking Claude to plan ${brand.header(`"${description}"`)}...`,
        );

        const skill = await loadPlannerSkill();
        if (!skill) {
          console.error(
            `${brand.sleepy('sleepy:')} planner skill not found. Run \`sleepy link-plugin\` from the sleepy repo.`,
          );
          process.exit(1);
        }
        const now = new Date();
        const plannerPrompt = buildPlannerPrompt({
          description,
          skillContent: skill,
          now,
        });

        let run;
        try {
          run = await runPlannerViaClaude(plannerPrompt);
        } catch (e) {
          console.error(
            `${brand.sleepy('sleepy:')} failed to launch planner — ${(e as Error).message}`,
          );
          process.exit(1);
        }

        if (run.exitCode !== 0) {
          console.error(
            `${brand.sleepy('sleepy:')} planner exited with code ${run.exitCode}`,
          );
          if (run.stderr) console.error(run.stderr);
          await rm(run.cwd, { recursive: true, force: true });
          process.exit(1);
        }

        const parsed = await readPlannerResultFile(run.cwd);
        await rm(run.cwd, { recursive: true, force: true });

        if (!parsed.ok || !parsed.value) {
          console.error(`${brand.sleepy('sleepy:')} ${parsed.error ?? 'unknown planner error'}`);
          process.exit(1);
        }
        const result = parsed.value;

        if (!result.path) {
          console.log('');
          console.log(`${brand.sleepy('sleepy:')} ${brand.error('✗')} no confident match found.`);
          console.log(`         ${brand.meta('reasoning: ' + result.reasoning)}`);
          if (result.candidates && result.candidates.length > 0) {
            console.log('');
            console.log(`${brand.sleepy('sleepy:')} candidates:`);
            for (const c of result.candidates) {
              console.log(`  - ${brand.header(c.name)}  ${brand.meta(c.path)}  — ${c.why}`);
            }
          }
          process.exit(1);
        }

        const valid = validatePlannerPath(result.path);
        if (!valid.ok) {
          console.error(
            `${brand.sleepy('sleepy:')} ${brand.error('planner returned unsafe path —')} ${valid.reason}`,
          );
          process.exit(1);
        }

        console.log('');
        console.log(`${brand.sleepy('sleepy:')} ${brand.success('✓')} plan resolved`);
        console.log(`         ${brand.meta('project:    ')}${brand.header(result.path)}`);
        console.log(`         ${brand.meta('confidence: ')}${result.confidence.toFixed(2)}`);

        let derivedDurationSpec: string | null = null;
        if (result.duration_iso) {
          derivedDurationSpec = durationFromIso(result.duration_iso, now);
          const prettyDeadline = new Date(result.duration_iso).toLocaleString();
          console.log(
            `         ${brand.meta('duration:   ')}${brand.header(derivedDurationSpec ?? result.duration_spec ?? '—')}${brand.meta('  (until ' + prettyDeadline + ')')}`,
          );
        }
        if (result.intensity) {
          console.log(`         ${brand.meta('intensity:  ')}${brand.header(result.intensity)}`);
        }
        if (result.focus_hint) {
          console.log(`         ${brand.meta('focus:      ')}${result.focus_hint}`);
        }
        if (result.scope_hint) {
          console.log(`         ${brand.meta('scope:      ')}${result.scope_hint}`);
        }
        if (result.token_cap) {
          console.log(
            `         ${brand.meta('token cap:  ')}${result.token_cap.toLocaleString('en-US')}`,
          );
        }
        console.log(`         ${brand.meta('reasoning:  ')}${result.reasoning}`);
        if (result.ambiguities && result.ambiguities.length > 0) {
          console.log(`         ${brand.meta('caveats:    ')}${result.ambiguities.join('; ')}`);
        }
        console.log('');

        if (!opts.yes) {
          const answer = await prompt(
            `${brand.sleepy('sleepy:')} proceed with this plan? ${brand.meta('[Y/n]')} `,
          );
          if (answer && answer.toLowerCase().startsWith('n')) {
            console.log(`${brand.sleepy('sleepy:')} ${brand.meta('cancelled.')}`);
            process.exit(0);
          }
        }

        if (result.user_goals_md) {
          try {
            await writeUserGoalsFile(result.path, result.user_goals_md);
            console.log(
              `${brand.sleepy('sleepy:')} wrote ${brand.header('.sleepy/USER_GOALS.md')} in target project`,
            );
          } catch (e) {
            console.error(
              `${brand.sleepy('sleepy:')} failed to write USER_GOALS.md — ${(e as Error).message}`,
            );
          }
        }

        // Dispatch sleepy start in the target directory
        const selfBin = fileURLToPath(import.meta.url);
        const binShim = path.resolve(
          path.dirname(selfBin),
          '..',
          '..',
          'bin',
          'sleepy.mjs',
        );

        const args = ['start'];
        if (opts.dryRun) args.push('--dry-run');
        if (result.intensity) {
          args.push('--intensity', result.intensity);
        }
        const durationToUse = derivedDurationSpec ?? result.duration_spec ?? null;
        if (durationToUse) {
          args.push('--duration', durationToUse);
        }
        if (result.token_cap) {
          args.push('--cap', String(result.token_cap));
        }

        console.log(
          `${brand.sleepy('sleepy:')} dispatching ${brand.meta('sleepy ' + args.join(' '))} in ${brand.meta(result.path)}`,
        );
        console.log('');
        const child = spawn('node', [binShim, ...args], {
          cwd: result.path,
          stdio: 'inherit',
        });
        const childExit: number = await new Promise((resolve) => {
          child.on('exit', (code) => resolve(code ?? -1));
        });
        process.exit(childExit);
      },
    );
}
