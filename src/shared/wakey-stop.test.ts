import { describe, it, expect } from 'vitest';
import { isStopResponse } from './wakey-stop';

describe('isStopResponse', () => {
  it('returns true for empty string', () => {
    expect(isStopResponse('')).toBe(true);
  });

  it('returns true for whitespace-only string', () => {
    expect(isStopResponse('   ')).toBe(true);
  });

  it('returns true for exact STOP', () => {
    expect(isStopResponse('STOP')).toBe(true);
    expect(isStopResponse('stop')).toBe(true);
    expect(isStopResponse('Stop')).toBe(true);
  });

  it('returns true for exact ABORT', () => {
    expect(isStopResponse('ABORT')).toBe(true);
    expect(isStopResponse('abort')).toBe(true);
  });

  it('returns true for exact DONE', () => {
    expect(isStopResponse('DONE')).toBe(true);
    expect(isStopResponse('done')).toBe(true);
  });

  it('returns true for STOP/ABORT/DONE as prefix word', () => {
    expect(isStopResponse('STOP — all tasks complete')).toBe(true);
    expect(isStopResponse('ABORT: destructive loop detected')).toBe(true);
    expect(isStopResponse('DONE. The goal is complete.')).toBe(true);
  });

  it('returns false for non-stop responses', () => {
    expect(isStopResponse('Run the tests')).toBe(false);
    expect(isStopResponse('inspect the failing test and fix the type error')).toBe(false);
    expect(isStopResponse('y')).toBe(false);
  });

  it('returns false when STOP/ABORT/DONE appears mid-sentence', () => {
    expect(isStopResponse('do not stop working')).toBe(false);
    expect(isStopResponse('mark this task as done in the board')).toBe(false);
  });
});
