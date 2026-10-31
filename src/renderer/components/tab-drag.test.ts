import { describe, it, expect } from 'vitest';
import { isDetachable, computeDropIndex } from './tab-drag';

describe('isDetachable', () => {
  it('allows CLI (undefined type) and most special tabs', () => {
    expect(isDetachable({ type: undefined }, false)).toBe(true);
    for (const t of ['browser-tab', 'kanban', 'team', 'project-tab', 'diff-viewer', 'file-reader', 'mcp-inspector'] as const) {
      expect(isDetachable({ type: t }, false)).toBe(true);
    }
  });
  it('blocks remote-terminal, sleepy, and actively-shared sessions', () => {
    expect(isDetachable({ type: 'remote-terminal' }, false)).toBe(false);
    expect(isDetachable({ type: 'sleepy' }, false)).toBe(false);
    expect(isDetachable({ type: undefined }, true)).toBe(false);
  });
});

describe('computeDropIndex', () => {
  const rects = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
  ];
  it('drops before a tab when in its left half', () => {
    expect(computeDropIndex(rects, 130)).toBe(1);
  });
  it('drops after a tab when in its right half', () => {
    expect(computeDropIndex(rects, 180)).toBe(2);
  });
  it('drops at the end past all tabs', () => {
    expect(computeDropIndex(rects, 999)).toBe(3);
  });
  it('drops at 0 for empty strip', () => {
    expect(computeDropIndex([], 50)).toBe(0);
  });
});
