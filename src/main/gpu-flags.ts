/** Minimal shape of Electron's `app.commandLine` — kept local so this module is
 * unit-testable without importing/mocking electron. */
interface CommandLineLike {
  appendSwitch(theSwitch: string, value?: string): void;
}

/**
 * GPU stability flags. MUST be applied before app `ready` (i.e. before the GPU
 * process first launches), so call this at module load in main.ts.
 *
 * Why this exists: Nightyard runs many simultaneous xterm.js terminals, and each
 * terminal loads the WebGL renderer addon (one WebGL context per terminal), plus
 * the 3D knowledge graph holds its own. Chromium caps simultaneous WebGL contexts
 * at 16 (`max_active_webgl_contexts`, a Blink compile-time constant — there is NO
 * runtime switch to raise it). Past that ceiling the single shared GPU process
 * thrashes and can crash. By default Chromium then permanently disables GPU
 * acceleration after 3 crashes, after which every new terminal paints a dead GPU
 * texture atlas — a black/garbled tab.
 *
 * `disable-gpu-process-crash-limit` removes that 3-strikes permanent-disable, so
 * the GPU process keeps respawning and terminals recover after a crash instead of
 * going black for the rest of the session.
 *
 * This is a crash-resilience stopgap, NOT a true fix for the context ceiling. The
 * only way to actually stop crossing 16 contexts is to bound WebGL to the visible
 * terminals (attach the addon on focus, dispose on hide) — see terminal-utils.ts.
 */
export function applyGpuStabilityFlags(commandLine: CommandLineLike): void {
  commandLine.appendSwitch('disable-gpu-process-crash-limit');
}
