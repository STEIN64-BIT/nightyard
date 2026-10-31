import { describe, it, expect, vi } from 'vitest';
import { createDeltaCoalescer, isNearBottom } from './stream-helpers.js';

describe('createDeltaCoalescer', () => {
  it('applies buffered chunks once per frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    const applied: string[] = [];
    const c = createDeltaCoalescer((t) => applied.push(t));
    c.push('a'); c.push('b'); c.push('c');
    expect(applied).toEqual([]);          // nothing until the frame fires
    frames[0](0);
    expect(applied).toEqual(['abc']);     // one concatenated apply
    expect(frames).toHaveLength(1);       // only one rAF scheduled for the burst
    vi.unstubAllGlobals();
  });
  it('flush applies immediately', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const applied: string[] = [];
    const c = createDeltaCoalescer((t) => applied.push(t));
    c.push('x'); c.flush();
    expect(applied).toEqual(['x']);
    vi.unstubAllGlobals();
  });

  it('falls back to applying immediately when requestAnimationFrame is undefined', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const applied: string[] = [];
    const c = createDeltaCoalescer((t) => applied.push(t));
    c.push('a');
    c.push('b');
    expect(applied).toEqual(['a', 'b']); // each push applies synchronously, no batching possible
    vi.unstubAllGlobals();
  });

  it('a second burst after a flush schedules and applies independently', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    const applied: string[] = [];
    const c = createDeltaCoalescer((t) => applied.push(t));
    c.push('a');
    c.flush();
    c.push('b');
    frames[1](0);
    expect(applied).toEqual(['a', 'b']);
    vi.unstubAllGlobals();
  });
});

describe('isNearBottom', () => {
  it('true within 80px of the bottom, false beyond', () => {
    expect(isNearBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 50 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 50 })).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 50 }, 200)).toBe(true);
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 50 }, 50)).toBe(false);
  });
});
