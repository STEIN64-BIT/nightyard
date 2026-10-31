import type { WakeyPhase } from '../../shared/types.js';

/**
 * Shared ASCII "eyes" animation for Wakey — one global 500ms ticker drives
 * every mounted face (panel rows, the collapsed pill, and the tab badge) so
 * they all animate in lockstep without each owning a timer.
 */
export type EyesPhase = 'thinking' | 'typing' | 'idle' | 'stopped' | 'orphaned' | 'error';

// Frame table — spec §3, exact strings/order.
const FRAMES: Record<EyesPhase, string[]> = {
  thinking: ['(o.o)', '(o.-)', '(o.o)', '(-.o)', '(0.0)'],
  typing:   ['(>.>)', '(<.<)'],
  idle:     ['(o.o)', '(o.o)', '(o.o)', '(o.o)', '(o.o)', '(o.o)', '(o.o)', '(-.-)'],
  stopped:  ['(-.-) zZz'],
  orphaned: ['(o.O)'],
  error:    ['(x.x)'],
};

/** Pure: which frame a phase shows at a given tick. */
export function eyesFrame(phase: EyesPhase, tick: number): string {
  const frames = FRAMES[phase];
  return frames[tick % frames.length];
}

/** Wraps a phase's current frame in a `data-wakey-eyes` span the ticker updates in place. */
export function eyesSpan(phase: EyesPhase): string {
  return `<span data-wakey-eyes data-wakey-phase="${phase}">${eyesFrame(phase, 0)}</span>`;
}

/**
 * Maps the mirror's `WakeyPhase` (plus whether the run is currently erroring)
 * to the `EyesPhase` the animation table understands. Shared by the panel and
 * the tab badge so both faces agree on what a run "looks like".
 *
 * `phase === 'typing'` is included for completeness (matches the spec's frame
 * table) but is never actually observable from a pushed snapshot — main sets
 * and clears it within a single broadcast debounce, so it never survives to
 * a render. Harmless dead-in-practice branch, not a bug.
 */
export function runPhaseToEyes(phase: WakeyPhase, hasErrors?: boolean): EyesPhase {
  if (phase === 'stopped') return 'stopped';
  if (phase === 'orphaned') return 'orphaned';
  if (hasErrors) return 'error';
  if (phase === 'thinking') return 'thinking';
  if (phase === 'typing') return 'typing';
  return 'idle';
}

let tick = 0;

/** Idempotent singleton: one 500ms interval that refreshes every mounted face. */
export function startEyesTicker(): void {
  if ((globalThis as any).__wakeyEyesTicker) return;
  (globalThis as any).__wakeyEyesTicker = setInterval(() => {
    tick++;
    document.querySelectorAll('[data-wakey-eyes]').forEach((el) => {
      const phase = (el.getAttribute('data-wakey-phase') as EyesPhase) ?? 'idle';
      el.textContent = eyesFrame(phase, tick);
    });
  }, 500);
}
