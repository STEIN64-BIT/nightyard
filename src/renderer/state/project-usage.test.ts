import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.stubGlobal('window', {
  nightyard: {
    store: { load: mockLoad, save: mockSave },
  },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

vi.mock('../session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('../session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

import { appState, _resetForTesting } from '../state';

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  _resetForTesting();
});

describe('ProjectRecord.lastUsedAt stamping', () => {
  it('is unset for a freshly-added project', () => {
    const project = appState.addProject('Test', '/test');
    expect(project.lastUsedAt).toBeUndefined();
  });

  it('addSession stamps the project lastUsedAt', () => {
    const project = appState.addProject('Test', '/test');
    const before = Date.now();
    appState.addSession(project.id, 'Session 1');
    expect(appState.activeProject!.lastUsedAt).toBeDefined();
    expect(appState.activeProject!.lastUsedAt!).toBeGreaterThanOrEqual(before);
  });

  it('setActiveProject stamps the project lastUsedAt', () => {
    const a = appState.addProject('A', '/a');
    appState.addProject('B', '/b'); // switches active project away from A
    expect(a.lastUsedAt).toBeUndefined(); // addProject alone does not stamp (only addSession/focus do)
    const before = Date.now();
    appState.setActiveProject(a.id);
    const found = appState.projects.find((p) => p.id === a.id)!;
    expect(found.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it('setActiveSession stamps the owning project lastUsedAt', () => {
    const project = appState.addProject('Test', '/test');
    const s1 = appState.addSession(project.id, 'Session 1')!;
    appState.addSession(project.id, 'Session 2');
    // Rewind the timestamp so we can prove setActiveSession bumps it again.
    project.lastUsedAt = 1;
    const before = Date.now();
    appState.setActiveSession(project.id, s1.id);
    expect(project.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it('focusing an older project moves it back to most-recently-used', () => {
    const a = appState.addProject('A', '/a');
    const b = appState.addProject('B', '/b');
    // Force a deterministic ordering (avoids relying on Date.now() clock resolution between calls).
    a.lastUsedAt = 100;
    b.lastUsedAt = 200;
    expect(b.lastUsedAt).toBeGreaterThan(a.lastUsedAt);

    appState.setActiveProject(a.id);
    const freshA = appState.projects.find((p) => p.id === a.id)!;
    const freshB = appState.projects.find((p) => p.id === b.id)!;
    expect(freshA.lastUsedAt!).toBeGreaterThanOrEqual(freshB.lastUsedAt!);
  });

  it('addSession stamps lastUsedAt for a background (non-active) project via commitNewSession alone', () => {
    const a = appState.addProject('A', '/a');
    appState.addProject('B', '/b'); // active project is now B, not A
    a.lastUsedAt = 1;
    appState.addSession(a.id, 'Session 1'); // addSession never calls setActiveProject
    expect(a.lastUsedAt!).toBeGreaterThan(1);
    expect(appState.activeProjectId).not.toBe(a.id); // still didn't switch active project
  });
});

describe('preferences.projectSortMode', () => {
  it('defaults to recent', () => {
    expect(appState.preferences.projectSortMode).toBe('recent');
  });

  it('setPreference persists the toggle to manual and back', () => {
    appState.setPreference('projectSortMode', 'manual');
    expect(appState.preferences.projectSortMode).toBe('manual');
    expect(mockSave).toHaveBeenCalled();

    appState.setPreference('projectSortMode', 'recent');
    expect(appState.preferences.projectSortMode).toBe('recent');
  });
});
