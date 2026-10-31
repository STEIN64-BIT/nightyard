export type UnifiedKind = 'project' | 'session' | 'subagent' | 'tool' | 'note' | 'tag' | 'folder';
export type LinkType = 'parent' | 'wiki' | 'tag' | 'folder' | 'session-note';

export interface UnifiedNode {
  id: string;
  kind: UnifiedKind;
  label: string;
  parentId: string | null;
  status?: string;       // agent nodes only
  degree?: number;       // set by store; sizes note nodes
}
export interface UnifiedLink { source: string; target: string; type: LinkType; }
export interface GraphData { nodes: UnifiedNode[]; links: UnifiedLink[]; }

export interface GraphBackend {
  mount(el: HTMLElement): void;
  update(data: GraphData): void;
  refresh?(data: GraphData): void;
  setMode(mode: '2d' | '3d'): void;
  setSearch?(q: string): void;
  setSelected?(id: string | null): void;
  destroy(): void;
  on?(event: 'nodeClick', cb: (id: string) => void): void;
}

export interface GraphRenderer {
  mount(el: HTMLElement): void;
  update(nodes: UnifiedNode[], links: UnifiedLink[]): void;
  setMode(mode: '2d' | '3d'): void;
  setDepth(depth: number): void;
  setSearch(q: string): void;
  setSelected(id: string | null): void;
  destroy(): void;
  on(event: 'nodeClick', cb: (id: string) => void): void;
}

const DEPTH_BY_KIND: Record<UnifiedKind, number> = {
  project: 0, session: 1, subagent: 2, tool: 3,
  note: 0, tag: 0, folder: 0, // knowledge kinds are exempt from the agent-depth slider (always shown)
};

export function parentLinks(nodes: ReadonlyArray<UnifiedNode>): UnifiedLink[] {
  return nodes.flatMap((n) => n.parentId ? [{ source: n.parentId, target: n.id, type: 'parent' as const }] : []);
}

export function createGraphRenderer(opts: { backendFactory: () => GraphBackend }): GraphRenderer {
  const backend = opts.backendFactory();
  let depth = 2;
  let lastNodes: UnifiedNode[] = [];
  let lastLinks: UnifiedLink[] = [];
  let lastSig = '';

  function render() {
    const visible = lastNodes.filter((n) => DEPTH_BY_KIND[n.kind] <= depth);
    const ids = new Set(visible.map((n) => n.id));
    const links = lastLinks.filter((l) => ids.has(l.source) && ids.has(l.target));
    const sig = visible.map((n) => n.id).sort().join('|') + '||' +
      links.map((l) => `${l.source}>${l.target}:${l.type}`).sort().join('|');
    const payload: GraphData = { nodes: visible, links: links.map((l) => ({ ...l })) };
    if (sig === lastSig) {
      if (backend.refresh) { backend.refresh(payload); return; }
      // fall through to update for backends without refresh
    }
    lastSig = sig;
    backend.update(payload);
  }

  return {
    mount: (el) => backend.mount(el),
    update: (nodes, links) => { lastNodes = nodes; lastLinks = links; render(); },
    setMode: (m) => backend.setMode(m),
    setDepth: (d) => { depth = d; render(); },
    setSearch: (q) => backend.setSearch?.(q),
    setSelected: (id) => backend.setSelected?.(id),
    destroy: () => backend.destroy(),
    on: (e, cb) => backend.on?.(e, cb),
  };
}
