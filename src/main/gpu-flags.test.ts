import { describe, it, expect, vi } from 'vitest';
import { applyGpuStabilityFlags } from './gpu-flags';

describe('applyGpuStabilityFlags', () => {
  it('keeps the GPU process respawning across crashes', () => {
    // Nightyard runs many xterm.js terminals, each holding a WebGL context, plus
    // the 3D graph. Past Chromium's 16-context ceiling the GPU process can crash;
    // by default Chromium permanently disables GPU acceleration after 3 crashes,
    // and every subsequent terminal then paints a dead texture atlas (black tab).
    // This switch keeps the GPU process respawning so terminals recover instead.
    const appendSwitch = vi.fn();

    applyGpuStabilityFlags({ appendSwitch });

    expect(appendSwitch).toHaveBeenCalledWith('disable-gpu-process-crash-limit');
  });

  it('appends every flag exactly once', () => {
    const appendSwitch = vi.fn();

    applyGpuStabilityFlags({ appendSwitch });

    const switches = appendSwitch.mock.calls.map((c) => c[0]);
    expect(switches.length).toBe(new Set(switches).size);
  });
});
