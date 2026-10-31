import { describe, it, expect } from 'vitest';
import { recordPrompt, recentPrompts, clearHistory } from './wakey-history';

describe('wakey-history', () => {
  it('keeps the last 5 prompts per session, newest first', () => {
    clearHistory('s1');
    for (let i = 1; i <= 7; i++) recordPrompt('s1', `prompt ${i}`);
    const r = recentPrompts('s1');
    expect(r).toHaveLength(5);
    expect(r[0]).toBe('prompt 7');
    expect(r[4]).toBe('prompt 3');
  });

  it('isolates sessions', () => {
    clearHistory('a'); clearHistory('b');
    recordPrompt('a', 'only-a');
    expect(recentPrompts('b')).toHaveLength(0);
  });

  it('returns a copy, not a reference to internal state', () => {
    clearHistory('s1');
    recordPrompt('s1', 'prompt 1');
    recordPrompt('s1', 'prompt 2');
    const r1 = recentPrompts('s1');
    r1.push('mutated');
    const r2 = recentPrompts('s1');
    expect(r1).toHaveLength(3);
    expect(r2).toHaveLength(2);
    expect(r2[0]).toBe('prompt 2');
  });
});
