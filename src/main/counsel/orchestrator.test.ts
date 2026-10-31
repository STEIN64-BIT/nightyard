import { describe, it, expect, vi } from 'vitest';
import { launchCounsel } from './orchestrator';
import type { CounselEvent, CounselStartConfig } from '../../shared/types';
import type { CounselRunner } from './runner';

function makeConfig(overrides: Partial<CounselStartConfig> = {}): CounselStartConfig {
  return {
    counselId: 'c1',
    projectPath: '/proj',
    prompt: 'Q?',
    seats: {
      A: { memberId: '1', memberName: 'Morgan Prime', memberRole: 'Butler', providerId: 'claude' },
      B: { memberId: '2', memberName: 'Staff Engineer', memberRole: 'Eng', providerId: 'claude' },
      C: { memberId: '3', memberName: 'Morgan Codex', memberRole: 'Familiar', providerId: 'codex' },
    },
    systemPrompts: { A: 'sysA', B: 'sysB', C: 'sysC' },
    style: 'balanced',
    contextPass: false,
    maxTurns: 9,
    minTurnsBeforeStop: 3,
    moderatorEnabled: true,
    ...overrides,
  };
}

const VALID_VERDICT = JSON.stringify({
  agreedPoints: [], disagreements: [], recommendation: 'do x', openQuestions: [], confidence: 'medium',
});

/** Scripted fake: turn texts come from `turnScript`; one-shots from `oneShotScript` (moderator+adjudicator in call order). */
function makeFakeRunner(turnScript: string[], oneShotScript: Array<string | Error>): CounselRunner & { turnPrompts: string[] } {
  let turnIdx = 0;
  let oneShotIdx = 0;
  const runner = {
    turnPrompts: [] as string[],
    async runTurn(_s: unknown, _sys: string, turnPrompt: string, onChunk: (t: string) => void) {
      runner.turnPrompts.push(turnPrompt);
      const text = turnScript[turnIdx++] ?? 'more argument';
      onChunk(text);
      return text;
    },
    async runOneShot() {
      const item = oneShotScript[oneShotIdx++] ?? VALID_VERDICT;
      if (item instanceof Error) throw item;
      return item;
    },
    async runContextPass() { return 'the brief'; },
    abortActive: vi.fn(),
  };
  return runner;
}

function collectEvents() {
  const events: CounselEvent[] = [];
  return { events, emit: (e: CounselEvent) => events.push(e) };
}

describe('launchCounsel', () => {
  it('runs A→B→C round-robin and always produces a verdict and done', async () => {
    const runner = makeFakeRunner([], [
      '{"decision":"continue"}', '{"decision":"continue"}', VALID_VERDICT,
    ]);
    const { events, emit } = collectEvents();
    const result = await launchCounsel(makeConfig(), { runner, emit, makeId: () => 'id' }).result;

    expect(result.turns.map((t) => t.seat)).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C']);
    expect(result.turns.map((t) => t.round)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(result.stoppedReason).toBe('max-turns');
    expect(result.verdict?.recommendation).toBe('do x');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('verdict');
    expect(types[types.length - 1]).toBe('done');

    // The status line must go truthful *before* the long-running calls, not
    // after they resolve — 'moderating'/'adjudicating' phase events precede
    // the 'moderator'/'verdict' events they describe.
    const moderatingPhaseIdx = events.findIndex((e) => e.type === 'phase' && e.phase === 'moderating');
    const moderatorIdx = events.findIndex((e) => e.type === 'moderator');
    expect(moderatingPhaseIdx).toBeGreaterThanOrEqual(0);
    expect(moderatingPhaseIdx).toBeLessThan(moderatorIdx);

    const adjudicatingPhaseIdx = events.findIndex((e) => e.type === 'phase' && e.phase === 'adjudicating');
    const verdictIdx = events.findIndex((e) => e.type === 'verdict');
    expect(adjudicatingPhaseIdx).toBeGreaterThanOrEqual(0);
    expect(adjudicatingPhaseIdx).toBeLessThan(verdictIdx);
  });

  it('emits an adjudicating phase event before verdict even when the moderator never runs', async () => {
    const runner = makeFakeRunner(['hello'], [VALID_VERDICT]);
    const { events, emit } = collectEvents();
    await launchCounsel(makeConfig({ maxTurns: 1, moderatorEnabled: false }), { runner, emit }).result;
    const types = events.map((e) => e.type);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'moderating')).toBe(false);
    const adjudicatingPhaseIdx = events.findIndex((e) => e.type === 'phase' && e.phase === 'adjudicating');
    expect(adjudicatingPhaseIdx).toBeGreaterThanOrEqual(0);
    expect(adjudicatingPhaseIdx).toBeLessThan(types.indexOf('verdict'));
  });

  it('streams deltas per turn', async () => {
    const runner = makeFakeRunner(['hello'], [VALID_VERDICT]);
    const { events, emit } = collectEvents();
    await launchCounsel(makeConfig({ maxTurns: 1, moderatorEnabled: false }), { runner, emit }).result;
    expect(events.some((e) => e.type === 'turn-delta' && e.chunk === 'hello')).toBe(true);
  });

  it('stops on converged after a completed round, not before minTurnsBeforeStop', async () => {
    const runner = makeFakeRunner([], ['{"decision":"converged","note":"agreed"}', VALID_VERDICT]);
    const { emit } = collectEvents();
    const result = await launchCounsel(makeConfig(), { runner, emit }).result;
    expect(result.turns).toHaveLength(3); // exactly one full round
    expect(result.stoppedReason).toBe('converged');
    expect(result.moderatorNotes[0].decision).toBe('converged');
  });

  it('injects a redirect note into exactly one subsequent prompt', async () => {
    const runner = makeFakeRunner([], [
      '{"decision":"redirect","note":"talk pricing"}', '{"decision":"continue"}', VALID_VERDICT,
    ]);
    const { emit } = collectEvents();
    await launchCounsel(makeConfig(), { runner, emit }).result;
    const withNote = runner.turnPrompts.filter((p) => p.includes('Moderator guidance: talk pricing'));
    expect(withNote).toHaveLength(1);
    expect(runner.turnPrompts[3]).toContain('talk pricing'); // the turn right after round 1
  });

  it('moderator does not run when disabled', async () => {
    const runner = makeFakeRunner([], [VALID_VERDICT]);
    const { events, emit } = collectEvents();
    await launchCounsel(makeConfig({ moderatorEnabled: false }), { runner, emit }).result;
    expect(events.some((e) => e.type === 'moderator')).toBe(false);
  });

  it('adjudicator failure yields the low-confidence fallback verdict', async () => {
    const runner = makeFakeRunner([], [
      '{"decision":"converged"}', new Error('adjudicator down'),
    ]);
    const { emit } = collectEvents();
    const result = await launchCounsel(makeConfig(), { runner, emit }).result;
    expect(result.verdict?.confidence).toBe('low');
    expect(result.verdict?.disagreements[0].topic).toBe('Adjudication unavailable');
  });

  it('a failing turn ends the debate with stoppedReason error but still adjudicates', async () => {
    const runner = makeFakeRunner([], [VALID_VERDICT]);
    runner.runTurn = vi.fn()
      .mockResolvedValueOnce('turn 1 ok')
      .mockRejectedValueOnce(new Error('CLI died'));
    const { events, emit } = collectEvents();
    const result = await launchCounsel(makeConfig(), { runner, emit }).result;
    expect(result.stoppedReason).toBe('error');
    expect(result.turns).toHaveLength(1);
    expect(result.verdict).toBeDefined();
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('stop() aborts the active child, ends the loop, and still adjudicates', async () => {
    let releaseTurn!: (v: string) => void;
    const runner = makeFakeRunner([], [VALID_VERDICT]);
    runner.runTurn = vi.fn()
      .mockResolvedValueOnce('turn 1')
      .mockImplementationOnce(() => new Promise((res) => { releaseTurn = res; }));
    const { emit } = collectEvents();
    const handle = launchCounsel(makeConfig(), { runner, emit });
    await vi.waitFor(() => expect(runner.runTurn).toHaveBeenCalledTimes(2));
    handle.stop();
    releaseTurn('turn 2 partial');
    const result = await handle.result;
    expect(runner.abortActive).toHaveBeenCalled();
    expect(result.stoppedReason).toBe('stopped');
    expect(result.verdict).toBeDefined();
  });

  it('context pass result is embedded in turn prompts and emitted', async () => {
    const runner = makeFakeRunner([], [VALID_VERDICT]);
    const { events, emit } = collectEvents();
    const result = await launchCounsel(
      makeConfig({ contextPass: true, maxTurns: 1, moderatorEnabled: false }), { runner, emit },
    ).result;
    expect(result.contextBrief).toBe('the brief');
    expect(events.some((e) => e.type === 'context' && e.brief === 'the brief')).toBe(true);
    expect(runner.turnPrompts[0]).toContain('Project context:\nthe brief');
  });

  it('context pass failure emits null brief and the debate proceeds', async () => {
    const runner = makeFakeRunner([], [VALID_VERDICT]);
    runner.runContextPass = vi.fn().mockRejectedValue(new Error('timeout'));
    const { events, emit } = collectEvents();
    const result = await launchCounsel(
      makeConfig({ contextPass: true, maxTurns: 1, moderatorEnabled: false }), { runner, emit },
    ).result;
    expect(result.contextBrief).toBeUndefined();
    expect(events.some((e) => e.type === 'context' && e.brief === null)).toBe(true);
    expect(result.turns).toHaveLength(1);
  });
});
