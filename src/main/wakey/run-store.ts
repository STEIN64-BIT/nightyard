import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// The run shape itself lives in src/shared/types.ts: preload and renderer are
// separate composite tsc projects that cannot import from src/main, but both
// need to type the persisted run they receive over IPC. Re-exported here so
// `from './run-store'` stays the canonical import path inside the main process.
import type { WakeyStopReason, WakeyHistoryEntry, WakeyRun } from '../../shared/types';
export type { WakeyPhase, WakeyHistoryEntry, WakeyRun } from '../../shared/types';
export type { WakeyStopReason as StopReason } from '../../shared/types';
type StopReason = WakeyStopReason;

export const RATE_CAP = 30;
export const RATE_WINDOW_MS = 3_600_000;
export const MAX_CONSECUTIVE_ERRORS = 3;

export const RUNS_FILE = path.join(os.homedir(), '.nightyard', 'wakey-runs.json');
const HISTORY_CAP = 50;

export function createRun(i: { sessionId: string; cliSessionId: string | null; projectPath: string; projectId: string; direction: string | null; now: number; runId?: string }): WakeyRun {
  return {
    runId: i.runId ?? crypto.randomUUID(),
    sessionId: i.sessionId, cliSessionId: i.cliSessionId,
    projectPath: i.projectPath, projectId: i.projectId,
    direction: i.direction, iterations: 0, phase: 'idle',
    lastSteer: null, history: [], transcriptOffset: 0, stop: null,
    supervisionTimestamps: [], consecutiveErrors: 0, startedAt: i.now, dismissed: false,
  };
}

export function isActive(run: WakeyRun): boolean {
  return !run.stop && !run.dismissed && run.phase !== 'orphaned';
}

function pushHistory(run: WakeyRun, entry: WakeyHistoryEntry): void {
  run.history.push(entry);
  if (run.history.length > HISTORY_CAP) run.history.splice(0, run.history.length - HISTORY_CAP);
}

/**
 * Count one supervision CYCLE against the rolling rate cap. Called at the top of
 * every cycle, not when a steer lands: a brain that keeps answering with filler
 * or repeats burns exactly as much as one that steers, and the cap exists to
 * bound turns, not typed keys. Prunes the window as it goes.
 */
export function recordSupervision(run: WakeyRun, now: number): void {
  run.supervisionTimestamps = run.supervisionTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
  run.supervisionTimestamps.push(now);
}

export function recordSteer(run: WakeyRun, text: string, now: number): void {
  run.iterations += 1;
  run.lastSteer = text;
  run.consecutiveErrors = 0;
  pushHistory(run, { at: now, kind: 'steer', text });
}

export function recordFastpath(run: WakeyRun, label: string, now: number): void {
  pushHistory(run, { at: now, kind: 'fastpath', text: label });
}

export function recordError(run: WakeyRun, message: string, now: number): void {
  run.consecutiveErrors += 1;
  pushHistory(run, { at: now, kind: 'error', text: message });
}

/**
 * Log that the supervisor brain behind this run was replaced (steer rejection,
 * turn-cap recycle, idle sweep). Not an error — the next cycle re-reads the
 * full transcript into the fresh brain — but the user should see it in history.
 */
export function recordBrainRestart(run: WakeyRun, text: string, now: number): void {
  pushHistory(run, { at: now, kind: 'brain-restart', text });
}

export function recentSteers(run: WakeyRun, n: number): string[] {
  return run.history.filter((h) => h.kind === 'steer').slice(-n).map((h) => h.text).reverse();
}

export function stopRun(run: WakeyRun, reason: StopReason, now: number): void {
  run.phase = 'stopped';
  run.stop = { reason, at: now };
}

export function rateCapExceeded(run: WakeyRun, now: number): boolean {
  return run.supervisionTimestamps.filter((t) => now - t < RATE_WINDOW_MS).length >= RATE_CAP;
}

export function loadRuns(file: string): WakeyRun[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveRuns(file: string, runs: WakeyRun[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(runs, null, 2));
  fs.renameSync(tmp, file);
}
