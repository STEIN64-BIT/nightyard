import { describe, it, expect } from 'vitest';
import { shouldForceSupervision } from './watchdog';

const MIN = 60_000;
const base = {
  phase: 'idle' as const, stopped: false, cooldownUntil: 0,
  lastSupervisionAt: 0, lastHookEventAt: 0, lastPtyOutputAt: 0,
  startedAt: 0, now: 10 * MIN, quietMinutes: 3,
};

describe('watchdog', () => {
  it('fires when everything has been quiet past the window', () => {
    expect(shouldForceSupervision({ ...base, lastSupervisionAt: 5 * MIN })).toBe(true);
  });
  it('does not fire when the pty produced output recently (Claude still working)', () => {
    expect(shouldForceSupervision({ ...base, lastSupervisionAt: 5 * MIN, lastPtyOutputAt: base.now - 30_000 })).toBe(false);
  });
  it('does not fire when a hook event arrived recently', () => {
    expect(shouldForceSupervision({ ...base, lastHookEventAt: base.now - MIN })).toBe(false);
  });
  it('does not fire while thinking/typing, when stopped, or during cooldown', () => {
    expect(shouldForceSupervision({ ...base, lastSupervisionAt: 5 * MIN, phase: 'thinking' })).toBe(false);
    expect(shouldForceSupervision({ ...base, lastSupervisionAt: 5 * MIN, stopped: true })).toBe(false);
    expect(shouldForceSupervision({ ...base, lastSupervisionAt: 5 * MIN, cooldownUntil: base.now + 1000 })).toBe(false);
  });
  it('does not insta-fire a fresh run (startedAt counts as activity)', () => {
    expect(shouldForceSupervision({ ...base, startedAt: base.now - MIN })).toBe(false);
    expect(shouldForceSupervision({ ...base, startedAt: base.now - 4 * MIN })).toBe(true);
  });
});
