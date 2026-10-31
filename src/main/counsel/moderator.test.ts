import { describe, it, expect } from 'vitest';
import { parseModeratorResult, moderate } from './moderator';
import type { CounselSeat, CounselSeatConfig } from '../../shared/types';

const seats: Record<CounselSeat, CounselSeatConfig> = {
  A: { memberId: '1', memberName: 'A1', memberRole: 'r', providerId: 'claude' },
  B: { memberId: '2', memberName: 'B1', memberRole: 'r', providerId: 'claude' },
  C: { memberId: '3', memberName: 'C1', memberRole: 'r', providerId: 'claude' },
};
const SAFE = { decision: 'continue', note: '' };

describe('parseModeratorResult (never throws)', () => {
  it('parses a clean decision', () => {
    expect(parseModeratorResult('{"decision":"converged","note":"agreed"}'))
      .toEqual({ decision: 'converged', note: 'agreed' });
  });
  it('parses fenced JSON', () => {
    expect(parseModeratorResult('```json\n{"decision":"redirect","note":"focus"}\n```'))
      .toEqual({ decision: 'redirect', note: 'focus' });
  });
  it('parses JSON wrapped in prose', () => {
    expect(parseModeratorResult('My call: {"decision":"continue"} — thanks')).toEqual(SAFE);
  });
  it('invalid decision value degrades to safe default', () => {
    expect(parseModeratorResult('{"decision":"explode","note":"x"}')).toEqual(SAFE);
  });
  it('empty string degrades to safe default', () => {
    expect(parseModeratorResult('')).toEqual(SAFE);
  });
  it('missing note defaults to empty string', () => {
    expect(parseModeratorResult('{"decision":"converged"}')).toEqual({ decision: 'converged', note: '' });
  });
});

describe('moderate', () => {
  it('returns the parsed decision from the runner', async () => {
    const r = await moderate(async () => '{"decision":"converged","note":""}', 'q', [], seats);
    expect(r.decision).toBe('converged');
  });
  it('a rejecting runner degrades to continue', async () => {
    const r = await moderate(async () => { throw new Error('spawn failed'); }, 'q', [], seats);
    expect(r).toEqual(SAFE);
  });
});

describe('parseModeratorResult (safe default freshness)', () => {
  it('returned defaults are fresh objects, not a shared singleton', () => {
    const first = parseModeratorResult('');
    first.note = 'mutated';
    expect(parseModeratorResult('')).toEqual({ decision: 'continue', note: '' });
  });

  it('non-string decision values degrade to safe default', () => {
    expect(parseModeratorResult('{"decision":123}')).toEqual({ decision: 'continue', note: '' });
    expect(parseModeratorResult('{"decision":null}')).toEqual({ decision: 'continue', note: '' });
  });
});
