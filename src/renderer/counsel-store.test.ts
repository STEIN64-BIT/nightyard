import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CounselEvent, CounselResult, CounselSeat, CounselSeatConfig, CounselStartConfig, CounselVerdict } from '../shared/types';

const mockLoad = vi.fn();
const mockSave = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockCheckEngines = vi.fn();
const mockUnsubscribe = vi.fn();
let capturedHandler: ((event: CounselEvent) => void) | null = null;
const mockOnEvent = vi.fn((cb: (event: CounselEvent) => void) => {
  capturedHandler = cb;
  return mockUnsubscribe;
});

vi.stubGlobal('window', {
  nightyard: {
    store: { load: mockLoad, save: mockSave },
    counsel: { start: mockStart, stop: mockStop, checkEngines: mockCheckEngines, onEvent: mockOnEvent },
  },
});

vi.mock('./session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('./session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('./provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(),
}));

import { appState, _resetForTesting as resetAppState } from './state';
import {
  startCounsel,
  stopCounsel,
  getActiveCounsel,
  onCounselChange,
  appendToHistory,
  clearActiveCounsel,
  _resetForTesting as resetCounselStore,
} from './counsel-store';

const seats: Record<CounselSeat, CounselSeatConfig> = {
  A: { memberId: 'm1', memberName: 'Morgan', memberRole: 'Generalist', providerId: 'claude' },
  B: { memberId: 'm2', memberName: 'Bea', memberRole: 'Skeptic', providerId: 'claude' },
  C: { memberId: 'm3', memberName: 'Cato', memberRole: 'Strategist', providerId: 'codex' },
};

function buildConfig(overrides: Partial<Omit<CounselStartConfig, 'counselId'>> = {}): Omit<CounselStartConfig, 'counselId'> {
  return {
    projectPath: '/proj',
    prompt: 'Should we ship?',
    seats,
    systemPrompts: { A: 'a-prompt', B: 'b-prompt', C: 'c-prompt' },
    style: 'balanced',
    contextPass: true,
    maxTurns: 9,
    minTurnsBeforeStop: 3,
    moderatorEnabled: true,
    ...overrides,
  };
}

function buildResult(counselId: string, overrides: Partial<CounselResult> = {}): CounselResult {
  return {
    counselId,
    prompt: 'Should we ship?',
    seats,
    style: 'balanced',
    turns: [],
    moderatorNotes: [],
    stoppedReason: 'max-turns',
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  // Reset store state first — a leftover subscription from the previous test
  // would otherwise fire mockUnsubscribe during this cleanup and pollute the
  // call count a test asserts on. Clear mocks last so every test starts with
  // a truly empty call history.
  resetAppState();
  resetCounselStore();
  vi.clearAllMocks();
  capturedHandler = null;
});

describe('startCounsel', () => {
  it('start subscribes and tracks the active counsel', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');

    const counselId = await startCounsel(project.id, buildConfig({ contextPass: false }));

    expect(counselId).toBe('c1');
    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    const active = getActiveCounsel();
    expect(active).not.toBeNull();
    expect(active!.counselId).toBe('c1');
    expect(active!.projectId).toBe(project.id);
    expect(active!.seats).toEqual(seats);
    expect(active!.status).toBe('debating');
    expect(active!.turns).toEqual([]);
    expect(active!.contextBrief).toBeNull();
    expect(active!.verdict).toBeNull();
    expect(active!.error).toBeNull();
    expect(active!.activeSeat).toBeNull();
  });

  it('initializes status to "context" (contextBrief pending) when contextPass is true', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');

    await startCounsel(project.id, buildConfig({ contextPass: true }));

    const active = getActiveCounsel()!;
    expect(active.status).toBe('context');
    expect(active.contextBrief).toBeUndefined();
  });

  it('reuses the existing onEvent subscription across multiple starts', async () => {
    mockStart.mockResolvedValueOnce('c1').mockResolvedValueOnce('c2');
    const project = appState.addProject('Proj', '/proj');

    await startCounsel(project.id, buildConfig());
    await startCounsel(project.id, buildConfig());

    expect(mockOnEvent).toHaveBeenCalledTimes(1);
  });
});

describe('pre-ack event buffering', () => {
  it('buffers events that arrive before the start() reply resolves, then replays them once active is set', async () => {
    let resolveStart!: (id: string) => void;
    mockStart.mockImplementation(() => new Promise<string>((resolve) => { resolveStart = resolve; }));
    const project = appState.addProject('Proj', '/proj');

    const startPromise = startCounsel(project.id, buildConfig({ contextPass: false }));
    const cb = vi.fn();
    onCounselChange(cb);

    // The orchestrator can emit 'start' (and, with contextPass:false, the
    // first 'turn-start'/'turn-delta') synchronously — well before the
    // counsel:start invoke's reply reaches the renderer.
    capturedHandler!({ type: 'start', counselId: 'c1', prompt: 'Should we ship?', seats });
    capturedHandler!({ type: 'turn-start', counselId: 'c1', turnId: 't1', seat: 'A', round: 1 });
    capturedHandler!({ type: 'turn-delta', counselId: 'c1', turnId: 't1', chunk: 'Hello' });

    // Nothing observable yet — `active` isn't assigned until start() resolves.
    expect(getActiveCounsel()).toBeNull();
    expect(cb).not.toHaveBeenCalled();

    resolveStart('c1');
    await startPromise;

    const active = getActiveCounsel()!;
    expect(active.counselId).toBe('c1');
    expect(active.turns).toHaveLength(1);
    expect(active.turns[0]).toMatchObject({ turnId: 't1', seat: 'A', round: 1, text: 'Hello', done: false });
    expect(active.activeSeat).toBe('A');
    expect(cb).toHaveBeenCalled();
  });

  it('_resetForTesting clears any buffered pre-ack events', async () => {
    let resolveStart!: (id: string) => void;
    mockStart.mockImplementation(() => new Promise<string>((resolve) => { resolveStart = resolve; }));
    const project = appState.addProject('Proj', '/proj');

    const startPromise = startCounsel(project.id, buildConfig({ contextPass: false }));
    capturedHandler!({ type: 'turn-start', counselId: 'c1', turnId: 't1', seat: 'A', round: 1 });

    resetCounselStore();
    resolveStart('c1');
    await startPromise;

    // The buffered turn-start was discarded by the reset, not replayed.
    expect(getActiveCounsel()!.turns).toEqual([]);
  });
});

describe('event handling', () => {
  it('turn-delta appends to the active turn text and notifies', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    const cb = vi.fn();
    onCounselChange(cb);

    capturedHandler!({ type: 'turn-start', counselId: 'c1', turnId: 't1', seat: 'A', round: 1 });
    capturedHandler!({ type: 'turn-delta', counselId: 'c1', turnId: 't1', chunk: 'Hello ' });
    capturedHandler!({ type: 'turn-delta', counselId: 'c1', turnId: 't1', chunk: 'world' });

    const active = getActiveCounsel()!;
    expect(active.turns).toHaveLength(1);
    expect(active.turns[0]).toMatchObject({ turnId: 't1', seat: 'A', round: 1, text: 'Hello world', done: false });
    expect(active.activeSeat).toBe('A');
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('turn-end marks the turn done and sets the canonical full text', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());

    capturedHandler!({ type: 'turn-start', counselId: 'c1', turnId: 't1', seat: 'A', round: 1 });
    capturedHandler!({ type: 'turn-delta', counselId: 'c1', turnId: 't1', chunk: 'partial' });
    capturedHandler!({ type: 'turn-end', counselId: 'c1', turnId: 't1', seat: 'A', fullText: 'the full text' });

    const turn = getActiveCounsel()!.turns[0];
    expect(turn.text).toBe('the full text');
    expect(turn.done).toBe(true);
  });

  it('context event sets the brief and moves status to debating', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig({ contextPass: true }));
    expect(getActiveCounsel()!.status).toBe('context');

    capturedHandler!({ type: 'context', counselId: 'c1', brief: 'brief text' });

    expect(getActiveCounsel()!.contextBrief).toBe('brief text');
    expect(getActiveCounsel()!.status).toBe('debating');
  });

  it('context event with a null brief (failed/skipped) still moves status to debating', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig({ contextPass: true }));

    capturedHandler!({ type: 'context', counselId: 'c1', brief: null });

    expect(getActiveCounsel()!.contextBrief).toBeNull();
    expect(getActiveCounsel()!.status).toBe('debating');
  });

  it('phase event updates status to moderating and notifies', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    const cb = vi.fn();
    onCounselChange(cb);

    capturedHandler!({ type: 'phase', counselId: 'c1', phase: 'moderating' });

    expect(getActiveCounsel()!.status).toBe('moderating');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('phase event updates status to adjudicating and notifies', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    const cb = vi.fn();
    onCounselChange(cb);

    capturedHandler!({ type: 'phase', counselId: 'c1', phase: 'adjudicating' });

    expect(getActiveCounsel()!.status).toBe('adjudicating');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('moderator event records the note and sets status to moderating', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());

    capturedHandler!({ type: 'moderator', counselId: 'c1', decision: 'continue', note: 'keep going', round: 1 });

    const active = getActiveCounsel()!;
    expect(active.moderatorNotes).toEqual([{ afterRound: 1, decision: 'continue', note: 'keep going' }]);
    expect(active.status).toBe('moderating');
  });

  it('verdict sets the verdict + status, and done finalizes status and clears activeSeat', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    capturedHandler!({ type: 'turn-start', counselId: 'c1', turnId: 't1', seat: 'B', round: 1 });

    const verdict: CounselVerdict = {
      agreedPoints: ['x'],
      disagreements: [],
      recommendation: 'do it',
      openQuestions: [],
      confidence: 'high',
    };
    capturedHandler!({ type: 'verdict', counselId: 'c1', verdict });

    expect(getActiveCounsel()!.verdict).toEqual(verdict);
    expect(getActiveCounsel()!.status).toBe('adjudicating');

    capturedHandler!({ type: 'done', counselId: 'c1', result: buildResult('c1', { verdict }) });

    expect(getActiveCounsel()!.status).toBe('done');
    expect(getActiveCounsel()!.activeSeat).toBeNull();
  });

  it('error event records the message', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());

    capturedHandler!({ type: 'error', counselId: 'c1', message: 'boom' });

    expect(getActiveCounsel()!.error).toBe('boom');
  });

  it('ignores events for a stale counselId (not the active one)', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    const cb = vi.fn();
    onCounselChange(cb);

    capturedHandler!({ type: 'turn-start', counselId: 'stale-id', turnId: 't1', seat: 'A', round: 1 });

    expect(getActiveCounsel()!.turns).toEqual([]);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('done → project history', () => {
  it('done appends the result to the project history and persists', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    mockSave.mockClear();

    const result = buildResult('c1', { stoppedReason: 'converged' });
    capturedHandler!({ type: 'done', counselId: 'c1', result });

    const stored = appState.projects.find((p) => p.id === project.id)!;
    expect(stored.counsels).toEqual([result]);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('history is capped at 20, dropping the oldest', async () => {
    mockStart.mockResolvedValue('c-new');
    const project = appState.addProject('Proj', '/proj');
    const initial: CounselResult[] = [];
    for (let i = 0; i < 20; i++) initial.push(buildResult(`old-${i}`));
    // Copy — appendToHistory mutates project.counsels in place (push+splice);
    // keeping `initial` as an independent snapshot to assert against.
    project.counsels = [...initial];

    await startCounsel(project.id, buildConfig());
    const fresh = buildResult('c-new');
    capturedHandler!({ type: 'done', counselId: 'c-new', result: fresh });

    const stored = appState.projects.find((p) => p.id === project.id)!;
    expect(stored.counsels).toHaveLength(20);
    expect(stored.counsels![0]).toBe(initial[1]);
    expect(stored.counsels![19]).toBe(fresh);
  });
});

describe('appendToHistory', () => {
  it('does nothing when the project does not exist', () => {
    expect(() => appendToHistory('missing-project', buildResult('c1'))).not.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('stopCounsel', () => {
  it('calls window.nightyard.counsel.stop with the active counselId', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());

    await stopCounsel();

    expect(mockStop).toHaveBeenCalledWith('c1');
  });

  it('does nothing when there is no active counsel', async () => {
    await stopCounsel();
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe('getActiveCounsel', () => {
  it('returns null when nothing is active', () => {
    expect(getActiveCounsel()).toBeNull();
  });
});

describe('clearActiveCounsel', () => {
  it('after a done event, nulls the active counsel and notifies listeners', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    capturedHandler!({ type: 'done', counselId: 'c1', result: buildResult('c1') });
    expect(getActiveCounsel()!.status).toBe('done');

    const cb = vi.fn();
    onCounselChange(cb);

    clearActiveCounsel();

    expect(getActiveCounsel()).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op when nothing is active', () => {
    expect(() => clearActiveCounsel()).not.toThrow();
    expect(getActiveCounsel()).toBeNull();
  });
});

describe('onCounselChange', () => {
  it('unsubscribe stops notifying only that specific callback', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onCounselChange(cb1);
    onCounselChange(cb2);

    unsub1();
    capturedHandler!({ type: 'turn-start', counselId: 'c1', turnId: 't1', seat: 'A', round: 1 });

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

describe('_resetForTesting', () => {
  it('clears active state, clears listeners, and unsubscribes from events', async () => {
    mockStart.mockResolvedValue('c1');
    const project = appState.addProject('Proj', '/proj');
    await startCounsel(project.id, buildConfig());
    const staleCb = vi.fn();
    onCounselChange(staleCb);

    resetCounselStore();

    expect(getActiveCounsel()).toBeNull();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

    // Prove listeners were cleared independently of the active-counsel reset:
    // start a fresh counsel and fire an event for it — the pre-reset
    // subscriber must not fire, even though a live counsel exists again.
    mockStart.mockResolvedValue('c2');
    await startCounsel(project.id, buildConfig());
    capturedHandler!({ type: 'turn-start', counselId: 'c2', turnId: 't1', seat: 'A', round: 1 });

    expect(staleCb).not.toHaveBeenCalled();
  });
});
