import { describe, it, expect, vi } from 'vitest';
import { createWakeyCore } from './wakey-core';
import type { WakeyBrain } from './wakey-brain';
import { createRun } from './run-store';

function scriptedBrain(script: Array<string | Error>): WakeyBrain {
  let i = 0, t = 0;
  return {
    steer: () => { t++; const s = script[Math.min(i++, script.length - 1)]; return s instanceof Error ? Promise.reject(s) : Promise.resolve(s); },
    turns: () => t,
    dispose: async () => {},
  };
}

function makeCore(script: Array<string | Error>, overrides: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const typed: string[] = [];
  const deps = {
    writePty: (_sid: string, data: string) => { typed.push(data); },
    readDelta: () => ({ text: 'ASSISTANT: did a thing', newOffset: 10, full: false }),
    matchDialog: () => null,
    brainFactory: () => scriptedBrain(script),
    superviseFallback: vi.fn().mockResolvedValue('fallback steer'),
    loadPrefs: () => ({ wakeyMaxIterations: 50, wakeySystemPrompt: 'sys', wakeyModel: 'sonnet', wakeyWatchdogMinutes: 3 }),
    persist: vi.fn(), broadcast: vi.fn(),
    now: () => now,
    ...overrides,
  };
  const core = createWakeyCore(deps as any);
  return { core, typed, deps, tick: (ms: number) => { now += ms; } };
}

const toggleOpts = { sessionId: 's1', projectId: 'p1', projectPath: '/p', cliSessionId: 'cli1', direction: 'fix tests' };

describe('wakey-core', () => {
  it('toggle on creates a run and fires the first supervision, typing the steer', async () => {
    const { core, typed } = makeCore(['run the vault tests']);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(typed.join('')).toContain('run the vault tests'));
    expect(core.snapshot().runs[0].iterations).toBe(1);
    // The phase now trails the write instead of being reset in the same tick,
    // so idle arrives once the (unverifiable — this session was never seen)
    // write settles right after Enter.
    await vi.waitFor(() => expect(core.snapshot().runs[0].phase).toBe('idle'));
  });

  it('holds the typing phase for the whole write and drops it when the echo lands', async () => {
    const { core, typed } = makeCore(['npm test']);
    core.onPtyData('s1', 'a quiet prompt');      // a seen session → the echo is verified
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(typed).toEqual(['npm test', '\r']));
    // The tail does not contain the steer yet, so the echo poll is still running
    // and the spec's (>.>)(<.<) eyes are genuinely observable.
    expect(core.snapshot().runs[0].phase).toBe('typing');
    core.onPtyData('s1', 'npm test');            // the session echoes it back
    await vi.waitFor(() => expect(core.snapshot().runs[0].phase).toBe('idle'));
    expect(core.snapshot().runs[0].history.some((h) => h.kind === 'error')).toBe(false);
  });

  it('STOP response stops the run with goal-complete and the run stays in the snapshot', async () => {
    const { core } = makeCore(['STOP']);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(core.snapshot().runs[0].stop?.reason).toBe('goal-complete'));
    expect(core.snapshot().runs).toHaveLength(1); // never silently vanishes
  });

  it('brain failure falls back to one-shot supervision; 3 consecutive errors auto-stop', async () => {
    const { core, deps } = makeCore([new Error('dead')]);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect((deps.superviseFallback as any).mock.calls.length).toBe(1));
    const { core: c2 } = makeCore([new Error('a')], {
      superviseFallback: vi.fn().mockRejectedValue(new Error('also dead')),
    });
    c2.toggle(toggleOpts);
    c2.onHookStatus('s1', 'completed'); // errors accrue over cycles… drive 3 cycles
    await vi.waitFor(() => expect(c2.snapshot().runs[0].stop?.reason ?? null).not.toBeNull(), { timeout: 3000 });
    expect(c2.snapshot().runs[0].stop?.reason).toBe('errors');
  });

  it('filler responses are rejected without typing', async () => {
    const { core, typed } = makeCore(['continue']);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(core.snapshot().runs[0].phase).toBe('idle'));
    expect(typed).toHaveLength(0);
  });

  it('hello rebinds a persisted run to the restored session by cliSessionId; unmatched runs orphan after grace', async () => {
    const { core, tick } = makeCore(['x']);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(core.snapshot().runs[0].iterations).toBe(1));
    core.hello([{ sessionId: 'NEW', cliSessionId: 'cli1', projectId: 'p1', projectPath: '/p' }]);
    expect(core.snapshot().runs[0].sessionId).toBe('NEW');
    const { core: c2, tick: t2 } = makeCore(['x']);
    c2.toggle(toggleOpts);
    await vi.waitFor(() => expect(c2.snapshot().runs[0].iterations).toBe(1));
    c2.hello([]);                        // nothing matches
    t2(61_000); c2.tickWatchdog();       // grace expiry is checked on the next tick
    expect(c2.snapshot().runs[0].phase).toBe('orphaned');
  });

  it('fast-path answers a stable matched dialog once and logs it', async () => {
    const match = { kind: 'trust' as const, keys: '\r', label: 'auto-answered folder-trust dialog' };
    const { core, typed, tick } = makeCore(['x'], { matchDialog: () => match });
    core.toggle({ ...toggleOpts, direction: undefined });
    await vi.waitFor(() => expect(core.snapshot().runs[0].iterations).toBe(1));
    // The steer's own write (text + Enter) has to be out of the way first — the
    // fast-path deliberately skips a run that is still typing, and that skip is
    // now genuinely reachable. Clear the buffer so only fast-path keys remain.
    await vi.waitFor(() => expect(core.snapshot().runs[0].phase).toBe('idle'));
    typed.length = 0;
    core.onPtyData('s1', 'Do you trust the files in this folder?');
    tick(2000); core.tickFastpath();
    expect(typed).toEqual(['\r']);
    expect(core.snapshot().runs[0].history.some((h) => h.kind === 'fastpath')).toBe(true);
    tick(5000); core.tickFastpath();     // same screen hash → answered only once
    expect(typed.filter((k) => k === '\r')).toHaveLength(1);
  });

  it('watchdog forces supervision after quiet minutes', async () => {
    const { core, tick } = makeCore(['first', 'second']);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(core.snapshot().runs[0].iterations).toBe(1));
    // The watchdog only fires on idle runs, and the first steer now holds the
    // run in `typing` until its write settles — wait that out before ticking.
    await vi.waitFor(() => expect(core.snapshot().runs[0].phase).toBe('idle'));
    tick(4 * 60_000);
    core.tickWatchdog();
    await vi.waitFor(() => expect(core.snapshot().runs[0].iterations).toBe(2));
  });

  it('every supervision cycle counts against the rate cap, even ones that reject filler', async () => {
    const { core, typed, tick } = makeCore(['continue']);
    const phase = () => core.snapshot().runs[0].phase;
    core.toggle(toggleOpts);                                    // cycle 1
    expect(phase()).toBe('thinking');
    await vi.waitFor(() => expect(phase()).toBe('idle'));
    for (let i = 2; i <= 30; i++) {
      tick(3_001);                                              // clear the reject cooldown
      core.onHookStatus('s1', 'completed');
      expect(phase()).toBe('thinking');                          // the cycle really ran
      await vi.waitFor(() => expect(phase()).toBe('idle'));
      expect(core.snapshot().runs[0].supervisionTimestamps).toHaveLength(i);
    }
    tick(3_001);
    core.onHookStatus('s1', 'completed');                        // cycle 31 → over the cap
    expect(core.snapshot().runs[0].stop?.reason).toBe('rate-cap');
    expect(core.snapshot().runs[0].iterations).toBe(0);          // not one steer was typed
    expect(typed).toHaveLength(0);
  });

  it('a rejected steer holds off the next cycle instead of hot-looping on hook events', async () => {
    const { core } = makeCore(['continue']);
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(core.snapshot().runs[0].phase).toBe('idle'));
    expect(core.snapshot().runs[0].supervisionTimestamps).toHaveLength(1);
    for (let i = 0; i < 5; i++) core.onHookStatus('s1', 'completed');  // a hook storm, no clock movement
    expect(core.snapshot().runs[0].supervisionTimestamps).toHaveLength(1);
  });

  it('a parked run never types into its session, even on a matching dialog + input hook', async () => {
    const parked = createRun({
      sessionId: 's1', cliSessionId: 'cli1', projectPath: '/p', projectId: 'p1',
      direction: null, now: 1_000_000,
    });
    const match = { kind: 'trust' as const, keys: '\r', label: 'auto-answered folder-trust dialog' };
    const { core, typed, tick } = makeCore(['x'], { initialRuns: [parked], matchDialog: () => match });
    core.onPtyData('s1', 'Do you trust the files in this folder?');
    core.onHookStatus('s1', 'input');                            // screen still painting → schedules a retry
    tick(2_000);                                                 // …by which time it has settled
    core.onHookStatus('s1', 'input');                            // the direct path
    core.tickFastpath();                                         // and the sweep
    await new Promise((resolve) => setTimeout(resolve, 1_800));  // let the scheduled retry fire

    expect(typed).toEqual([]);                                   // nothing bound → nothing typed
    expect(core.snapshot().runs[0].history).toEqual([]);
  });
});

// --- regression guards added after review (not part of the brief's block) ----

/** A brain that fails, but late enough that a stop can land mid-cycle. */
function slowFailingBrain(): WakeyBrain {
  return {
    steer: () => new Promise<string>((_ok, reject) => { setTimeout(() => reject(new Error('dead')), 30); }),
    turns: () => 1,
    dispose: async () => {},
  };
}

describe('wakey-core — a stopped run must never be acted on', () => {
  it('a new cliSessionId binds the active run, not the stopped one on the same session', async () => {
    const { core } = makeCore(['steer once']);
    core.toggle(toggleOpts);                     // run A
    await vi.waitFor(() => expect(core.snapshot().runs[0].iterations).toBe(1));
    core.stopBySession('s1');
    core.toggle(toggleOpts);                     // run B, same session, same cli id
    await vi.waitFor(() => expect(core.snapshot().runs[1]?.iterations).toBe(1));

    const [a, b] = core.snapshot().runs;
    expect(a.stop?.reason).toBe('user');
    core.onCliSessionId('s1', 'cli2');           // the user /cleared

    expect(b.cliSessionId).toBe('cli2');         // the live run follows the session
    expect(b.transcriptOffset).toBe(0);          // …and re-reads the new transcript
    expect(a.cliSessionId).toBe('cli1');         // the stopped run is left alone
    expect(a.transcriptOffset).toBe(10);
  });

  it('a steer whose echo never lands is not retyped after the run is stopped', async () => {
    const { core, typed } = makeCore(['npm test']);
    core.onPtyData('s1', 'a quiet prompt');      // a seen session → the echo is verified
    core.toggle(toggleOpts);
    await vi.waitFor(() => expect(typed).toEqual(['npm test', '\r']));

    // The tail never shows the steer, so the 1.5s echo poll is now running and
    // would retype the whole thing when it times out.
    core.stopBySession('s1');
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(typed).toEqual(['npm test', '\r']);   // no retype
    expect(core.snapshot().runs[0].history.some((h) => h.kind === 'error')).toBe(false);
  });

  it('a run stopped inside the Enter delay never gets its steer submitted', async () => {
    const { core, typed } = makeCore(['npm test']);
    core.toggle(toggleOpts);
    while (!typed.includes('npm test')) await new Promise((resolve) => setTimeout(resolve, 1));
    core.stopBySession('s1');                    // inside the 80ms text→Enter gap
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(typed).toEqual(['npm test']);         // the text sits unsubmitted
  });

  it('a stop while the brain is failing skips the one-shot fallback spawn', async () => {
    const superviseFallback = vi.fn().mockResolvedValue('fallback steer');
    const { core, typed } = makeCore([], { superviseFallback, brainFactory: slowFailingBrain });
    core.toggle(toggleOpts);
    core.stopBySession('s1');                    // stopped before the brain rejects
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(superviseFallback).not.toHaveBeenCalled();
    expect(typed).toEqual([]);
  });

  it('a brain error that trips the cap after a user stop keeps the user stop reason', async () => {
    const nearCap = createRun({
      sessionId: 's1', cliSessionId: 'cli1', projectPath: '/p', projectId: 'p1',
      direction: 'fix tests', now: 1_000_000,
    });
    nearCap.consecutiveErrors = 2;               // the next error trips MAX_CONSECUTIVE_ERRORS
    const { core } = makeCore([], { initialRuns: [nearCap], brainFactory: slowFailingBrain });
    core.hello([{ sessionId: 's1', cliSessionId: 'cli1', projectId: 'p1', projectPath: '/p' }]);
    core.onHookStatus('s1', 'completed');
    core.stopBySession('s1');                    // stopped before the brain rejects
    await new Promise((resolve) => setTimeout(resolve, 200));

    const run = core.snapshot().runs[0];
    expect(run.consecutiveErrors).toBe(3);
    expect(run.stop?.reason).toBe('user');       // not relabelled 'errors'
  });
});
