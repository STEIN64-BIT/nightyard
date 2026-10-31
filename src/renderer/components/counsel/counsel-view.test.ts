import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActiveCounsel } from '../../counsel-store.js';

// Fake the store's real onCounselChange contract (a Set of listeners, added
// on subscribe and removed by the returned unsubscribe) instead of importing
// the real counsel-store — this lets the test assert on listener count
// directly ("second subscription trick") without pulling in state.ts's full
// dependency graph.
const { mockGetActiveCounsel, mockOnCounselChange, listeners } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    mockGetActiveCounsel: vi.fn<() => ActiveCounsel | null>(),
    mockOnCounselChange: vi.fn((cb: () => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
  };
});
function fakeStoreNotify(): void {
  for (const cb of listeners) cb();
}

vi.mock('../../counsel-store.js', () => ({
  getActiveCounsel: mockGetActiveCounsel,
  onCounselChange: mockOnCounselChange,
}));

const { mockRenderStartView, mockResetStartView } = vi.hoisted(() => ({
  mockRenderStartView: vi.fn(),
  mockResetStartView: vi.fn(),
}));
vi.mock('./start-view.js', () => ({
  renderStartView: mockRenderStartView,
  resetStartView: mockResetStartView,
}));

const { mockRenderDebate } = vi.hoisted(() => ({ mockRenderDebate: vi.fn() }));
vi.mock('./debate-view.js', () => ({
  renderDebate: mockRenderDebate,
}));

import { renderCounsel, teardownCounsel } from './counsel-view';

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  mockGetActiveCounsel.mockReturnValue(null);
});

describe('renderCounsel subscription lifecycle', () => {
  it('subscribes exactly once per root and paints immediately', () => {
    const root = {} as HTMLElement;
    renderCounsel(root, 'proj-1');

    expect(mockOnCounselChange).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    expect(mockRenderStartView).toHaveBeenCalledTimes(1);
  });

  it('a store notification repaints the root while still subscribed (control case)', () => {
    const root = {} as HTMLElement;
    renderCounsel(root, 'proj-1');
    mockRenderStartView.mockClear();

    fakeStoreNotify();

    expect(mockRenderStartView).toHaveBeenCalledTimes(1);
  });
});

describe('teardownCounsel', () => {
  it('unsubscribes the root — a later store notification no longer repaints it', () => {
    const root = {} as HTMLElement;
    renderCounsel(root, 'proj-1');
    mockRenderStartView.mockClear();

    teardownCounsel(root);

    expect(listeners.size).toBe(0);
    fakeStoreNotify();
    expect(mockRenderStartView).not.toHaveBeenCalled();
    expect(mockRenderDebate).not.toHaveBeenCalled();
  });

  it('is a safe no-op for a root that was never rendered (or already torn down)', () => {
    const root = {} as HTMLElement;
    expect(() => teardownCounsel(root)).not.toThrow();

    renderCounsel(root, 'proj-1');
    teardownCounsel(root);
    expect(() => teardownCounsel(root)).not.toThrow(); // double-teardown is safe
  });

  it('only tears down the given root, leaving other roots subscribed', () => {
    const rootA = {} as HTMLElement;
    const rootB = {} as HTMLElement;
    renderCounsel(rootA, 'proj-1');
    renderCounsel(rootB, 'proj-2');
    mockRenderStartView.mockClear();

    teardownCounsel(rootA);

    expect(listeners.size).toBe(1);
    fakeStoreNotify();
    expect(mockRenderStartView).toHaveBeenCalledTimes(1);
  });
});
