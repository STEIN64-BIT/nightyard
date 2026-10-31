import { describe, it, expect } from 'vitest';
import { eyesFrame } from './wakey-eyes';

describe('wakey-eyes', () => {
  it('cycles the thinking scan-blink', () => {
    expect(eyesFrame('thinking', 0)).toBe('(o.o)');
    expect(eyesFrame('thinking', 1)).toBe('(o.-)');
    expect(eyesFrame('thinking', 4)).toBe('(0.0)');
    expect(eyesFrame('thinking', 5)).toBe('(o.o)'); // wraps
  });
  it('typing alternates shifty eyes', () => {
    expect(eyesFrame('typing', 0)).toBe('(>.>)');
    expect(eyesFrame('typing', 1)).toBe('(<.<)');
  });
  it('idle blinks once per 8 ticks', () => {
    const frames = Array.from({ length: 8 }, (_, t) => eyesFrame('idle', t));
    expect(frames.filter((f) => f === '(-.-)')).toHaveLength(1);
  });
  it('stopped/orphaned/error are static', () => {
    expect(eyesFrame('stopped', 3)).toBe('(-.-) zZz');
    expect(eyesFrame('orphaned', 9)).toBe('(o.O)');
    expect(eyesFrame('error', 1)).toBe('(x.x)');
  });
});
