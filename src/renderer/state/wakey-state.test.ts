import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WakeyRun, WakeySnapshot } from '../../shared/types';

// --- window.nightyard.wakey stub -------------------------------------------
// The renderer mirror is a thin IPC facade now: every mutating call forwards
// to window.nightyard.wakey.*, and all read state comes from the pushed/fetched
// WakeySnapshot. Capture the onState callback so tests can simulate the main
// process pushing a fresh snapshot.

const wakeyToggle = vi.fn().mockResolvedValue(undefined);
const wakeyStop = vi.fn().mockResolvedValue(undefined);
const wakeyDismiss = vi.fn().mockResolvedValue(undefined);
const wakeyHello = vi.fn().mockResolvedValue(undefined);
const wakeySetProjectDefault = vi.fn().mockResolvedValue(undefined);
const wakeyBoardContext = vi.fn().mockResolvedValue(undefined);
const wakeyGetState = vi.fn().mockResolvedValue({ runs: [], projectDefaults: {} } as WakeySnapshot);
let capturedOnState: ((s: WakeySnapshot) => void) | null = null;
const wakeyOnState = vi.fn((cb: (s: WakeySnapshot) => void) => {
  capturedOnState = cb;
  return () => { capturedOnState = null; };
});

const mockSave = vi.fn();
vi.stubGlobal('window', {
  nightyard: {
    store: { load: vi.fn(), save: mockSave },
    wakey: {
      toggle: wakeyToggle,
      stop: wakeyStop,
      dismiss: wakeyDismiss,
      hello: wakeyHello,
      setProjectDefault: wakeySetProjectDefault,
      boardContext: wakeyBoardContext,
      getState: wakeyGetState,
      onState: wakeyOnState,
    },
  },
});

vi.mock('../session-cost.js', () => ({ getCost: vi.fn().mockReturnValue(null), restoreCost: vi.fn() }));
vi.mock('../session-context.js', () => ({ restoreContext: vi.fn() }));
vi.mock('../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

let uuidSeq = 0;
vi.stubGlobal('crypto', { randomUUID: () => `test-uuid-${++uuidSeq}` });

import { appState, _resetForTesting as resetAppState } from '../state';
import {
  initWakeyMirror,
  toggleWakey,
  stopWakey,
  isWakeyOn,
  getIterations,
  getPhase,
  getLastPrompt,
  getDirection,
  hasRunErrors,
  listEnabledSessions,
  getRuns,
  dismissRun,
  restartRun,
  onWakeyChange,
  setProjectDefaultDirection,
  effectiveDirection,
  _resetForTesting,
} from './wakey-state';

function makeRun(overrides: Partial<WakeyRun> = {}): WakeyRun {
  return {
    runId: 'run-1',
    sessionId: 's1',
    cliSessionId: null,
    projectPath: '/p1',
    projectId: 'proj-1',
    direction: null,
    iterations: 0,
    phase: 'idle',
    lastSteer: null,
    history: [],
    transcriptOffset: 0,
    stop: null,
    supervisionTimestamps: [],
    consecutiveErrors: 0,
    startedAt: Date.now(),
    dismissed: false,
    ...overrides,
  };
}

function pushSnapshot(snap: WakeySnapshot): void {
  expect(capturedOnState).toBeTruthy();
  capturedOnState!(snap);
}

describe('wakey-state (renderer mirror)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidSeq = 0;
    resetAppState();
    _resetForTesting();
    capturedOnState = null;
    wakeyGetState.mockResolvedValue({ runs: [], projectDefaults: {} } as WakeySnapshot);
  });

  it('(a) toggleWakey on a session without a run sends wakey.toggle with the project path + direction', () => {
    const project = appState.addProject('P', '/p1');
    const session = appState.addSession(project.id, 'S1')!;

    toggleWakey(session.id, '  build the parser  ');

    expect(wakeyToggle).toHaveBeenCalledTimes(1);
    expect(wakeyToggle).toHaveBeenCalledWith({
      sessionId: session.id,
      projectId: project.id,
      projectPath: '/p1',
      cliSessionId: null,
      direction: 'build the parser',
      boardContext: undefined,
    });
  });

  it('(b) an incoming snapshot flips isWakeyOn/getIterations/getRuns and fires onWakeyChange listeners', () => {
    initWakeyMirror();
    const listener = vi.fn();
    onWakeyChange(listener);

    expect(isWakeyOn('s1')).toBe(false);
    expect(getIterations('s1')).toBe(0);
    expect(getRuns()).toEqual([]);

    const run = makeRun({ sessionId: 's1', iterations: 3, phase: 'thinking' });
    pushSnapshot({ runs: [run], projectDefaults: {} });

    expect(isWakeyOn('s1')).toBe(true);
    expect(getIterations('s1')).toBe(3);
    expect(getPhase('s1')).toBe('thinking');
    expect(getRuns()).toEqual([run]);
    expect(listener).toHaveBeenCalled();
  });

  it('(c) toggleWakey on a session WITH an active run still sends the same wakey.toggle IPC (core interprets as stop)', () => {
    initWakeyMirror();
    const project = appState.addProject('P', '/p2');
    const session = appState.addSession(project.id, 'S1')!;
    const run = makeRun({ sessionId: session.id, projectId: project.id, projectPath: '/p2', phase: 'typing' });
    pushSnapshot({ runs: [run], projectDefaults: {} });
    expect(isWakeyOn(session.id)).toBe(true);

    toggleWakey(session.id);

    expect(wakeyToggle).toHaveBeenCalledWith({
      sessionId: session.id,
      projectId: project.id,
      projectPath: '/p2',
      cliSessionId: null,
      direction: undefined,
      boardContext: undefined,
    });
  });

  it('(d) stopWakey sends wakey.stop', () => {
    stopWakey('s1');
    expect(wakeyStop).toHaveBeenCalledWith('s1');
  });

  it('(f) a snapshot containing a stopped run keeps it in getRuns() but not listEnabledSessions()', () => {
    initWakeyMirror();
    const stoppedRun = makeRun({ sessionId: 's-stopped', phase: 'stopped', stop: { reason: 'user', at: Date.now() } });
    const activeRun = makeRun({ runId: 'run-2', sessionId: 's-active', phase: 'thinking' });
    pushSnapshot({ runs: [stoppedRun, activeRun], projectDefaults: {} });

    expect(getRuns()).toEqual([stoppedRun, activeRun]);
    expect(listEnabledSessions()).toEqual(['s-active']);
    expect(isWakeyOn('s-stopped')).toBe(false);
    expect(isWakeyOn('s-active')).toBe(true);
  });

  it('hasRunErrors reflects consecutiveErrors on the ACTIVE run only', () => {
    initWakeyMirror();
    const erroring = makeRun({ sessionId: 's-erroring', phase: 'thinking', consecutiveErrors: 2 });
    const healthy = makeRun({ runId: 'run-2', sessionId: 's-healthy', phase: 'thinking', consecutiveErrors: 0 });
    const stoppedWithErrors = makeRun({
      runId: 'run-3', sessionId: 's-stopped', phase: 'stopped',
      stop: { reason: 'errors', at: Date.now() }, consecutiveErrors: 3,
    });
    pushSnapshot({ runs: [erroring, healthy, stoppedWithErrors], projectDefaults: {} });

    expect(hasRunErrors('s-erroring')).toBe(true);
    expect(hasRunErrors('s-healthy')).toBe(false);
    expect(hasRunErrors('s-stopped')).toBe(false); // no active run — stopped runs never count
    expect(hasRunErrors('s-unknown')).toBe(false);
  });

  it('dismissRun sends wakey.dismiss', () => {
    dismissRun('run-1');
    expect(wakeyDismiss).toHaveBeenCalledWith('run-1');
  });

  it('restartRun re-toggles the same session when it is still alive in appState', () => {
    initWakeyMirror();
    const project = appState.addProject('P', '/p3');
    const session = appState.addSession(project.id, 'S1')!;
    const run = makeRun({
      runId: 'run-alive', sessionId: session.id, projectId: project.id, projectPath: '/p3',
      phase: 'stopped', stop: { reason: 'user', at: Date.now() }, direction: 'keep going',
    });
    pushSnapshot({ runs: [run], projectDefaults: {} });

    restartRun('run-alive');

    expect(wakeyToggle).toHaveBeenCalledWith({
      sessionId: session.id,
      projectId: project.id,
      projectPath: '/p3',
      cliSessionId: null,
      direction: 'keep going',
      boardContext: undefined,
    });
  });

  it('restartRun spawns a new session when the old one is gone, then toggles it', () => {
    initWakeyMirror();
    const project = appState.addProject('P', '/p4');
    const run = makeRun({
      runId: 'run-gone', sessionId: 'session-that-no-longer-exists', projectId: project.id, projectPath: '/p4',
      phase: 'orphaned', direction: null,
    });
    pushSnapshot({ runs: [run], projectDefaults: {} });

    restartRun('run-gone');

    expect(wakeyToggle).toHaveBeenCalledTimes(1);
    const [opts] = wakeyToggle.mock.calls[0];
    expect(opts.projectId).toBe(project.id);
    expect(opts.projectPath).toBe('/p4');
    expect(opts.direction).toBeUndefined();
    // A new session should have been created under the project.
    const refreshed = appState.projects.find((p) => p.id === project.id)!;
    expect(refreshed.sessions.some((s) => s.id === opts.sessionId)).toBe(true);
  });

  it('getLastPrompt reads lastSteer, defaulting to empty string', () => {
    initWakeyMirror();
    expect(getLastPrompt('s1')).toBe('');
    const run = makeRun({ sessionId: 's1', lastSteer: 'do the thing' });
    pushSnapshot({ runs: [run], projectDefaults: {} });
    expect(getLastPrompt('s1')).toBe('do the thing');
  });

  it('restartRun does nothing (no IPC) when the run is still active', () => {
    initWakeyMirror();
    const project = appState.addProject('P', '/p-active');
    const session = appState.addSession(project.id, 'S1')!;
    const run = makeRun({
      runId: 'run-active', sessionId: session.id, projectId: project.id, projectPath: '/p-active',
      phase: 'thinking', stop: null, dismissed: false,
    });
    pushSnapshot({ runs: [run], projectDefaults: {} });

    restartRun('run-active');

    expect(wakeyToggle).not.toHaveBeenCalled();
  });
});

// --- per-project default direction ---
// These tests exercise setProjectDefaultDirection + effectiveDirection.
// They need appState.projects to hold real project records, so we set up
// a minimal window.nightyard stub and use appState.addProject to seed data.

describe('per-project default direction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidSeq = 0;
    resetAppState();
    _resetForTesting();
    capturedOnState = null;
  });

  it('falls back to project default when session has none', () => {
    const project = appState.addProject('P', '/p');
    setProjectDefaultDirection(project.id, 'keep tests green');
    expect(effectiveDirection(project.id, undefined)).toBe('keep tests green');
    expect(effectiveDirection(project.id, 'session override')).toBe('session override');
    expect(effectiveDirection('other-project-id', undefined)).toBeUndefined();
  });

  it('whitespace direction removes the default', () => {
    const project = appState.addProject('P2', '/p2');
    setProjectDefaultDirection(project.id, 'initial default');
    expect(effectiveDirection(project.id, undefined)).toBe('initial default');
    setProjectDefaultDirection(project.id, '   ');
    expect(effectiveDirection(project.id, undefined)).toBeUndefined();
  });

  it('trimmed session direction wins over project default', () => {
    const project = appState.addProject('P3', '/p3');
    setProjectDefaultDirection(project.id, 'project fallback');
    expect(effectiveDirection(project.id, '  active goal  ')).toBe('active goal');
  });

  it('persists the default direction on the project record', () => {
    const project = appState.addProject('P4', '/p4');
    setProjectDefaultDirection(project.id, 'persist me');
    expect(appState.projects.find((p) => p.id === project.id)?.wakeyDefaultDirection).toBe('persist me');
  });

  it('also forwards the live default to wakey.setProjectDefault', () => {
    const project = appState.addProject('P5', '/p5');
    setProjectDefaultDirection(project.id, 'live effect');
    expect(wakeySetProjectDefault).toHaveBeenCalledWith(project.id, 'live effect');
  });
});

// --- seeding persisted defaults into main on hello ---
// Main's `projectDefaults` map (wakey-core.ts) is in-memory and only ever
// written via the `wakey:set-project-default` IPC — it never reads the
// persisted `project.wakeyDefaultDirection` field itself. So a default saved
// in a previous app session must be re-forwarded on every hello, otherwise
// main resolves an empty direction for a resumed run after restart.

describe('hello seeds persisted project defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidSeq = 0;
    resetAppState();
    _resetForTesting();
    capturedOnState = null;
  });

  it('forwards setProjectDefault for every project with a persisted default, before hello, and not for projects without one', () => {
    const withDefault = appState.addProject('P1', '/p1');
    withDefault.wakeyDefaultDirection = 'keep tests green';
    const withoutDefault = appState.addProject('P2', '/p2');
    void withoutDefault;

    initWakeyMirror(); // projects already loaded → hits the "already present" branch directly

    expect(wakeySetProjectDefault).toHaveBeenCalledTimes(1);
    expect(wakeySetProjectDefault).toHaveBeenCalledWith(withDefault.id, 'keep tests green');

    // setProjectDefault must fire before hello, so a resumed run's next
    // supervision cycle already sees the default.
    const setDefaultOrder = wakeySetProjectDefault.mock.invocationCallOrder[0];
    const helloOrder = wakeyHello.mock.invocationCallOrder[0];
    expect(setDefaultOrder).toBeLessThan(helloOrder);
  });

  it('does not call setProjectDefault at all when no project has a persisted default', () => {
    appState.addProject('P1', '/p1');

    initWakeyMirror();

    expect(wakeySetProjectDefault).not.toHaveBeenCalled();
    expect(wakeyHello).toHaveBeenCalledTimes(1);
  });

  it('skips a whitespace-only persisted default (treated as no default)', () => {
    const project = appState.addProject('P1', '/p1');
    project.wakeyDefaultDirection = '   ';

    initWakeyMirror();

    expect(wakeySetProjectDefault).not.toHaveBeenCalled();
  });
});
