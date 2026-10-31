import { describe, it, expect } from 'vitest';
import { mergeGraphs } from './knowledge-graph-store.js';
import type { VaultGraph } from '../shared/types.js';
import type { UnifiedNode } from './graph-renderer/index.js';

const vault: VaultGraph = {
  notes: [
    { id: 'A.md', title: 'A', folder: '', tags: ['x'], wikilinks: ['B'], mtimeMs: 0 },
    { id: 'B.md', title: 'B', folder: '', tags: [], wikilinks: [], mtimeMs: 0 },
  ],
  links: [{ source: 'A.md', target: 'B.md', type: 'wiki' }],
};

describe('mergeGraphs', () => {
  it('produces note nodes with degree, tag nodes, and tag links', () => {
    const { nodes, links } = mergeGraphs(vault, [], []);
    const a = nodes.find((n) => n.id === 'A.md')!;
    expect(a.kind).toBe('note');
    expect(a.degree).toBe(1);
    expect(nodes.find((n) => n.id === 'tag:x')?.kind).toBe('tag');
    expect(links).toContainEqual({ source: 'A.md', target: 'tag:x', type: 'tag' });
  });

  it('links agent sessions to the note they were launched from', () => {
    const agents: UnifiedNode[] = [{ id: 's1', kind: 'session', label: 'work on A', parentId: 'p1' }];
    const { links } = mergeGraphs(vault, agents, [{ sessionId: 's1', noteId: 'A.md' }]);
    expect(links).toContainEqual({ source: 'A.md', target: 's1', type: 'session-note' });
  });

  it('drops session-note link when note id is missing', () => {
    const agents: UnifiedNode[] = [{ id: 's1', kind: 'session', label: 'work on A', parentId: 'p1' }];
    const { links } = mergeGraphs(vault, agents, [{ sessionId: 's1', noteId: 'missing.md' }]);
    expect(links).not.toContainEqual({ source: 'missing.md', target: 's1', type: 'session-note' });
  });

  it('dedupes a shared tag into one node with a link per note', () => {
    const v: VaultGraph = { notes: [
      { id: 'A.md', title: 'A', folder: '', tags: ['x'], wikilinks: [], mtimeMs: 0 },
      { id: 'B.md', title: 'B', folder: '', tags: ['x'], wikilinks: [], mtimeMs: 0 },
    ], links: [] };
    const { nodes, links } = mergeGraphs(v, [], []);
    expect(nodes.filter((n) => n.id === 'tag:x')).toHaveLength(1);
    expect(links.filter((l) => l.type === 'tag')).toHaveLength(2);
  });

  it('drops session-note link when session id is missing and keeps agent parent links', () => {
    const agents: UnifiedNode[] = [{ id: 's1', kind: 'session', label: 'S', parentId: 'p1' }];
    const { links } = mergeGraphs(vault, agents, [{ sessionId: 'ghost', noteId: 'A.md' }]);
    expect(links.find((l) => l.type === 'session-note')).toBeUndefined();
    expect(links).toContainEqual({ source: 'p1', target: 's1', type: 'parent' });
  });
});
