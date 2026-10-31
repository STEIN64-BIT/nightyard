import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRun, isActive, recordSteer, recordSupervision, recordFastpath, recordError, recordBrainRestart,
  recentSteers, stopRun, rateCapExceeded, loadRuns, saveRuns, RATE_CAP, MAX_CONSECUTIVE_ERRORS,
} from './run-store';

const base = { sessionId: 's1', cliSessionId: 'cli1', projectPath: '/p', projectId: 'pr1', direction: null, now: 1000 };

describe('run-store', () => {
  it('creates an active idle run with a stable runId', () => {
    const run = createRun(base);
    expect(run.phase).toBe('idle');
    expect(run.iterations).toBe(0);
    expect(isActive(run)).toBe(true);
    expect(run.runId).toBeTruthy();
    expect(createRun(base).runId).not.toBe(run.runId);
  });

  it('recordSteer bumps iterations, resets consecutiveErrors, tracks history newest-last', () => {
    const run = createRun(base);
    recordError(run, 'boom', 1500);
    recordSteer(run, 'run the tests', 2000);
    recordSteer(run, 'fix the types', 3000);
    expect(run.iterations).toBe(2);
    expect(run.consecutiveErrors).toBe(0);
    expect(run.lastSteer).toBe('fix the types');
    expect(run.history.map((h) => h.kind)).toEqual(['error', 'steer', 'steer']);
    expect(recentSteers(run, 2)).toEqual(['fix the types', 'run the tests']);
    // The rate cap counts cycles, not steers — recordSteer must not double-count.
    expect(run.supervisionTimestamps).toEqual([]);
  });

  it('recordSupervision is what feeds the rate-cap window, prunes it, and leaves the steer fields alone', () => {
    const run = createRun(base);
    recordSupervision(run, 1000);
    recordSupervision(run, 2000);
    expect(run.supervisionTimestamps).toEqual([1000, 2000]);
    expect(run.iterations).toBe(0);
    expect(run.history).toEqual([]);
    // anything older than the rolling window falls out on the next record
    recordSupervision(run, 3_602_001);
    expect(run.supervisionTimestamps).toEqual([3_602_001]);
  });

  it('caps history at 50 entries', () => {
    const run = createRun(base);
    for (let i = 0; i < 60; i++) recordSteer(run, `steer ${i}`, 1000 + i);
    expect(run.history.length).toBe(50);
    expect(run.history[49].text).toBe('steer 59');
  });

  it('stopRun sets phase + reason and deactivates', () => {
    const run = createRun(base);
    stopRun(run, 'goal-complete', 5000);
    expect(run.phase).toBe('stopped');
    expect(run.stop).toEqual({ reason: 'goal-complete', at: 5000 });
    expect(isActive(run)).toBe(false);
  });

  it('dismissed and orphaned runs are inactive', () => {
    const a = createRun(base); a.dismissed = true;
    const b = createRun(base); b.phase = 'orphaned';
    expect(isActive(a)).toBe(false);
    expect(isActive(b)).toBe(false);
  });

  it('rate cap trips at RATE_CAP supervisions within the window and recovers after it', () => {
    const run = createRun(base);
    for (let i = 0; i < RATE_CAP; i++) recordSupervision(run, 10_000 + i);
    expect(rateCapExceeded(run, 20_000)).toBe(true);
    expect(rateCapExceeded(run, 10_000 + RATE_CAP + 3_600_000)).toBe(false);
  });

  it('a run that only ever typed steers still has an empty rate-cap window', () => {
    const run = createRun(base);
    for (let i = 0; i < RATE_CAP * 2; i++) recordSteer(run, `s${i}`, 10_000 + i);
    expect(rateCapExceeded(run, 20_000)).toBe(false);
  });

  it('recordError counts consecutive errors up to the stop threshold', () => {
    const run = createRun(base);
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) recordError(run, 'x', 1000 + i);
    expect(run.consecutiveErrors).toBe(MAX_CONSECUTIVE_ERRORS);
  });

  it('recordBrainRestart logs history without touching iterations or the error count', () => {
    const run = createRun(base);
    recordError(run, 'brain: dead', 1500);
    recordBrainRestart(run, 'supervisor brain restarted', 1600);
    expect(run.history.map((h) => h.kind)).toEqual(['error', 'brain-restart']);
    expect(run.history[1]).toEqual({ at: 1600, kind: 'brain-restart', text: 'supervisor brain restarted' });
    expect(run.iterations).toBe(0);
    expect(run.consecutiveErrors).toBe(1);
    // shares the capped push path — 50 entries max, newest last
    for (let i = 0; i < 60; i++) recordBrainRestart(run, `restart ${i}`, 2000 + i);
    expect(run.history.length).toBe(50);
    expect(run.history[49].text).toBe('restart 59');
  });

  it('save/load round-trips and tolerates missing or corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakey-'));
    const file = path.join(dir, 'runs.json');
    const run = createRun(base);
    recordSteer(run, 'hello', 2000);
    saveRuns(file, [run]);
    expect(loadRuns(file)).toEqual([run]);
    expect(loadRuns(path.join(dir, 'nope.json'))).toEqual([]);
    fs.writeFileSync(file, '{corrupt');
    expect(loadRuns(file)).toEqual([]);
  });
});
