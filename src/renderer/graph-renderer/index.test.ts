import { createGraphRenderer, parentLinks } from './index';
import type { GraphNode } from '../agent-graph-store';
import type { GraphData, UnifiedNode, UnifiedLink } from './index';

const node = (id: string, parentId: string | null = null): GraphNode =>
  ({ id, kind: 'session', parentId, label: id, status: 'working', startedAt: 0, lastEventAt: 0 });

describe('createGraphRenderer (fake backend)', () => {
  it('passes graph data to the backend on update', () => {
    const calls: any[] = [];
    const r = createGraphRenderer({ backendFactory: () => ({
      mount: () => {}, update: (d) => calls.push(d), setMode: () => {}, destroy: () => {},
    }) });
    const nodes = [node('a'), node('b', 'a')];
    r.update(nodes, parentLinks(nodes));
    expect(calls.at(-1).nodes).toHaveLength(2);
    expect(calls.at(-1).links).toEqual([{ source: 'a', target: 'b', type: 'parent' }]);
  });

  it('filters by depth before passing to backend', () => {
    const calls: any[] = [];
    const r = createGraphRenderer({ backendFactory: () => ({
      mount: () => {}, update: (d) => calls.push(d), setMode: () => {}, destroy: () => {},
    }) });
    const project = { ...node('p'), kind: 'project' as const, parentId: null };
    const session = { ...node('s', 'p') };
    const sub = { ...node('a', 's'), kind: 'subagent' as const };
    r.setDepth(1); // projects + sessions only
    r.update([project, session, sub], parentLinks([project, session, sub]));
    expect(calls.at(-1).nodes.map((n: any) => n.id).sort()).toEqual(['p', 's']);
    // links touching hidden nodes must also be filtered out
    expect(calls.at(-1).links.every((l: UnifiedLink) => l.source !== 'a' && l.target !== 'a')).toBe(true);
  });

  it('survives backends that mutate link endpoints (d3-force behavior)', () => {
    const capturedSources: string[][] = [];
    const update = vi.fn((data: GraphData) => {
      // capture sources before mutation (simulating d3-force inspection point)
      capturedSources.push(data.links.map((l) => l.source as string));
      // simulate d3-force replacing string ids with node objects
      for (const l of data.links) (l as any).source = { id: l.source };
    });
    const r = createGraphRenderer({ backendFactory: () => ({ mount: vi.fn(), update, setMode: vi.fn(), destroy: vi.fn() }) });
    const nodes: UnifiedNode[] = [
      { id: 'p', kind: 'project', label: 'P', parentId: null },
      { id: 's', kind: 'session', label: 'S', parentId: 'p' },
    ];
    r.update(nodes, parentLinks(nodes));
    r.setDepth(2);
    // second render (setDepth) must still deliver 1 link with string source
    // (if lastLinks were corrupted by the first mutation, filter would drop all links)
    expect(update).toHaveBeenCalledTimes(2);
    expect(capturedSources.at(-1)).toEqual(['p']);
  });

  it('passes note/tag nodes and typed links through to the backend', () => {
    const update = vi.fn();
    const r = createGraphRenderer({ backendFactory: () => ({ mount: vi.fn(), update, setMode: vi.fn(), destroy: vi.fn() }) });
    const nodes: UnifiedNode[] = [
      { id: 'B.md', kind: 'note', label: 'B', parentId: null },
      { id: 'tag:marketing', kind: 'tag', label: '#marketing', parentId: null },
    ];
    r.update(nodes, [{ source: 'B.md', target: 'tag:marketing', type: 'tag' }]);
    const data = update.mock.calls.at(-1)![0];
    expect(data.nodes).toHaveLength(2);
    expect(data.links[0].type).toBe('tag');
  });

  it('skips backend.update and calls refresh when topology unchanged', () => {
    const update = vi.fn(); const refresh = vi.fn();
    const r = createGraphRenderer({ backendFactory: () => ({ mount: vi.fn(), update, refresh, setMode: vi.fn(), destroy: vi.fn() }) });
    const nodes: UnifiedNode[] = [{ id: 'p', kind: 'project', label: 'P', parentId: null, status: 'idle' }];
    r.update(nodes, []);
    expect(update).toHaveBeenCalledTimes(1);
    r.update([{ ...nodes[0], status: 'working' }], []); // same topology, changed field
    expect(update).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    r.update([...nodes, { id: 's', kind: 'session', label: 'S', parentId: 'p' }], []); // topology changed
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('falls back to update when backend lacks refresh', () => {
    const update = vi.fn();
    const r = createGraphRenderer({ backendFactory: () => ({ mount: vi.fn(), update, setMode: vi.fn(), destroy: vi.fn() }) });
    const nodes: UnifiedNode[] = [{ id: 'p', kind: 'project', label: 'P', parentId: null }];
    r.update(nodes, []);
    r.update(nodes, []);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
