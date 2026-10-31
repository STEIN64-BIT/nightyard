import { describe, it, expect } from 'vitest';
import { mergeDefaultArgs } from './args-utils';

describe('mergeDefaultArgs', () => {
  it('returns empty string when both args are missing', () => {
    expect(mergeDefaultArgs(undefined, undefined)).toBe('');
    expect(mergeDefaultArgs('', '')).toBe('');
  });

  it('returns the populated side when the other is empty', () => {
    expect(mergeDefaultArgs('--global', '')).toBe('--global');
    expect(mergeDefaultArgs('', '--project')).toBe('--project');
    expect(mergeDefaultArgs(undefined, '--project')).toBe('--project');
  });

  it('concatenates global before project args', () => {
    expect(mergeDefaultArgs('--dangerously-skip-permissions', '--model sonnet'))
      .toBe('--dangerously-skip-permissions --model sonnet');
  });

  it('deduplicates exact-token matches preserving order', () => {
    expect(mergeDefaultArgs(
      '--dangerously-skip-permissions --model opus',
      '--dangerously-skip-permissions --model sonnet'
    )).toBe('--dangerously-skip-permissions --model opus --model sonnet');
  });

  it('collapses internal whitespace', () => {
    expect(mergeDefaultArgs('  --a   --b  ', '  --c  ')).toBe('--a --b --c');
  });
});
