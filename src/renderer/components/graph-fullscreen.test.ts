import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stub browser-only graph modules so force-graph never executes ─────────────
vi.mock('../graph-renderer/index.js', () => ({ createGraphRenderer: vi.fn(), parentLinks: vi.fn(() => []) }));
vi.mock('../graph-renderer/renderer-2d.js', () => ({ create2dBackend: vi.fn() }));
vi.mock('../graph-renderer/renderer-3d.js', () => ({ create3dBackend: vi.fn(() => null) }));
vi.mock('../knowledge-graph-store.js', () => ({ mergeGraphs: vi.fn(() => ({ nodes: [], links: [] })) }));
vi.mock('./node-detail-panel.js', () => ({ renderNodeDetail: vi.fn() }));

// ── Minimal appState mock ────────────────────────────────────────────────────
vi.mock('../state.js', () => ({
  appState: {
    get projects() { return _mockProjects; },
  },
}));

let _mockProjects: Array<{ id: string; sessions: Array<{ id: string; sourceNoteId?: string }> }> = [];

beforeEach(() => {
  _mockProjects = [];
  vi.resetModules();
});

// Lazy import so mocks are registered before module evaluation.
async function getModule() {
  return import('./graph-fullscreen.js');
}

describe('buildSessionNoteLinks', () => {
  it('returns empty array when no projects', async () => {
    const { buildSessionNoteLinks } = await getModule();
    expect(buildSessionNoteLinks()).toEqual([]);
  });

  it('returns empty array when no sessions have sourceNoteId', async () => {
    _mockProjects = [
      { id: 'p1', sessions: [{ id: 's1' }, { id: 's2' }] },
    ];
    const { buildSessionNoteLinks } = await getModule();
    expect(buildSessionNoteLinks()).toEqual([]);
  });

  it('maps sessions with sourceNoteId to SessionNoteLink objects', async () => {
    _mockProjects = [
      {
        id: 'p1',
        sessions: [
          { id: 's1', sourceNoteId: 'Notes/A.md' },
          { id: 's2' },
          { id: 's3', sourceNoteId: 'Notes/B.md' },
        ],
      },
    ];
    const { buildSessionNoteLinks } = await getModule();
    const links = buildSessionNoteLinks();
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({ sessionId: 's1', noteId: 'Notes/A.md' });
    expect(links).toContainEqual({ sessionId: 's3', noteId: 'Notes/B.md' });
  });

  it('aggregates sessions across multiple projects', async () => {
    _mockProjects = [
      { id: 'p1', sessions: [{ id: 's1', sourceNoteId: 'Notes/A.md' }] },
      { id: 'p2', sessions: [{ id: 's2', sourceNoteId: 'Notes/C.md' }] },
    ];
    const { buildSessionNoteLinks } = await getModule();
    const links = buildSessionNoteLinks();
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({ sessionId: 's1', noteId: 'Notes/A.md' });
    expect(links).toContainEqual({ sessionId: 's2', noteId: 'Notes/C.md' });
  });
});

describe('buildNodeDetailExtras', () => {
  const vault = {
    notes: [
      { id: 'a.md', title: 'Alpha', folder: 'ventures', tags: ['x', 'y'], wikilinks: [], mtimeMs: 0 },
      { id: 'b.md', title: 'Beta', folder: '', tags: ['x'], wikilinks: [], mtimeMs: 0 },
    ],
    links: [],
  };

  it('session node: project/provider/status meta + goto target', async () => {
    const { buildNodeDetailExtras } = await getModule();
    const projects = [{
      id: 'p1', name: 'nightyard', path: '/tmp/vy',
      sessions: [{ id: 's1', name: 'Fix orbs', providerId: 'claude', createdAt: '2026-08-01T10:00:00Z', cliSessionId: null }],
    }];
    const ex = buildNodeDetailExtras(
      { id: 's1', kind: 'session', label: 'Fix orbs', parentId: 'p1', status: 'working' },
      projects as never, vault as never,
    );
    expect(ex.gotoSession).toEqual({ projectId: 'p1', sessionId: 's1' });
    const labels = ex.meta.map((m) => m.label);
    expect(labels).toEqual(expect.arrayContaining(['Project', 'Provider', 'Status', 'Created']));
    expect(ex.meta.find((m) => m.label === 'Project')!.value).toBe('nightyard');
    expect(ex.meta.find((m) => m.label === 'Status')!.value).toBe('working');
  });

  it('session node no longer in appState: no goto, explanatory meta', async () => {
    const { buildNodeDetailExtras } = await getModule();
    const ex = buildNodeDetailExtras(
      { id: 'gone', kind: 'session', label: 'S', parentId: null },
      [] as never, vault as never,
    );
    expect(ex.gotoSession).toBeUndefined();
    expect(ex.meta.some((m) => m.value === 'Session no longer open')).toBe(true);
  });

  it('tag node: note count + bulleted titles preview', async () => {
    const { buildNodeDetailExtras } = await getModule();
    const ex = buildNodeDetailExtras(
      { id: 'tag:x', kind: 'tag', label: '#x', parentId: null },
      [] as never, vault as never,
    );
    expect(ex.meta).toEqual([{ label: 'Notes', value: '2' }]);
    expect(ex.preview).toBe('• Alpha\n• Beta');
  });

  it('note node: folder, tags, degree', async () => {
    const { buildNodeDetailExtras } = await getModule();
    const ex = buildNodeDetailExtras(
      { id: 'a.md', kind: 'note', label: 'Alpha', parentId: null, degree: 3 },
      [] as never, vault as never,
    );
    expect(ex.meta).toEqual([
      { label: 'Folder', value: 'ventures' },
      { label: 'Tags', value: '#x #y' },
      { label: 'Links', value: '3' },
    ]);
  });

  it('project node: path + session count', async () => {
    const { buildNodeDetailExtras } = await getModule();
    const projects = [{ id: 'p1', name: 'vy', path: '/tmp/vy', sessions: [{ id: 's1' }, { id: 's2' }] }];
    const ex = buildNodeDetailExtras(
      { id: 'p1', kind: 'project', label: 'vy', parentId: null },
      projects as never, vault as never,
    );
    expect(ex.meta).toEqual([
      { label: 'Path', value: '/tmp/vy' },
      { label: 'Sessions', value: '2' },
    ]);
  });
});
