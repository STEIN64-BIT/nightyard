import { access } from 'node:fs/promises';
import { sleepyPaths } from '../paths.js';
import { type ClaudeLauncher } from './launcher.js';
import { recordIterationTokens } from './budget-recorder.js';
import {
  readNextAction,
  clearNextAction,
  type NextAction,
} from '../state/next-action.js';

export type IterationStatus = 'ok' | 'failed' | 'stopped' | 'panicked';

export interface IterationOutcome {
  status: IterationStatus;
  tokensRecorded: number;
  durationMs: number;
  error?: string;
  actionHandled?: NextAction;
}

export type NextActionHandler = (action: NextAction) => Promise<void | 'unproductive'>;

export interface RunOneIterationInput {
  projectRoot: string;
  launcher: ClaudeLauncher;
  prompt: string;
  now: Date;
  onNextAction?: NextActionHandler;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function requestedStop(projectRoot: string): Promise<'stopped' | 'panicked' | null> {
  const paths = sleepyPaths(projectRoot);
  if (await fileExists(paths.panicFlag)) return 'panicked';
  if (await fileExists(paths.stopFlag)) return 'stopped';
  return null;
}

export async function runOneIteration(
  input: RunOneIterationInput,
): Promise<IterationOutcome> {
  const paths = sleepyPaths(input.projectRoot);

  if (await fileExists(paths.panicFlag)) {
    return { status: 'panicked', tokensRecorded: 0, durationMs: 0 };
  }
  if (await fileExists(paths.stopFlag)) {
    return { status: 'stopped', tokensRecorded: 0, durationMs: 0 };
  }

  // Clear any stale next-action from a previous iteration before launching.
  await clearNextAction(input.projectRoot);

  let result;
  try {
    result = await input.launcher.run({ prompt: input.prompt, cwd: input.projectRoot });
  } catch (err) {
    const stop = await requestedStop(input.projectRoot);
    return { status: stop ?? 'failed', tokensRecorded: 0, durationMs: 0, error: String(err) };
  }

  const recorded = await recordIterationTokens({
    projectRoot: input.projectRoot,
    sessionFile: result.sessionFile,
    iterationDurationMs: result.durationMs,
    at: input.now,
  });

  // A stop during planning must not dispatch a fresh worker, even if the
  // planner exits successfully after receiving SIGTERM.
  const stop = await requestedStop(input.projectRoot);
  if (stop) {
    await clearNextAction(input.projectRoot);
    return { status: stop, tokensRecorded: recorded.tokensRecorded, durationMs: result.durationMs };
  }

  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      tokensRecorded: recorded.tokensRecorded,
      durationMs: result.durationMs,
      error: result.stderr || `agent exited with code ${result.exitCode}`,
    };
  }

  // Wrap next-action reading in try/catch so a schema parse error
  // (e.g. orchestrator wrote an unexpected category) doesn't crash
  // the supervisor loop.
  let action: NextAction | null = null;
  try {
    action = await readNextAction(input.projectRoot);
  } catch (parseErr) {
    // Log but don't crash — treat as an iteration with no action
    console.error(
      `sleepy: warning — failed to parse next-action.json: ${(parseErr as Error).message}. Skipping this action.`,
    );
    await clearNextAction(input.projectRoot);
  }
  let actionHandled: NextAction | undefined;
  if (action && input.onNextAction) {
    try {
      const handled = await input.onNextAction(action);
      const stop = await requestedStop(input.projectRoot);
      if (stop) return { status: stop, tokensRecorded: recorded.tokensRecorded, durationMs: result.durationMs };
      if (handled !== 'unproductive') actionHandled = action;
    } catch (err) {
      const stop = await requestedStop(input.projectRoot);
      return { status: stop ?? 'failed', tokensRecorded: recorded.tokensRecorded, durationMs: result.durationMs, error: String(err) };
    } finally {
      await clearNextAction(input.projectRoot);
    }
  }

  return {
    status: 'ok',
    tokensRecorded: recorded.tokensRecorded,
    durationMs: result.durationMs,
    ...(actionHandled !== undefined ? { actionHandled } : {}),
  };
}
