import ForceGraph from 'force-graph';
import type { GraphBackend, GraphData, UnifiedNode } from './index.js';

const COLOR: Record<string, string> = {
  working: '#22c55e', waiting: '#f59e0b', input: '#f59e0b', completed: '#94a3b8', idle: '#64748b',
};

const KIND_COLOR: Record<string, string> = {
  note: '#7dd3fc', tag: '#c084fc', folder: '#475569',
};

// Relative node sizes by kind (projects largest, tools smallest).
const SIZE: Record<string, number> = {
  project: 8, session: 4, subagent: 3, tool: 1.5, note: 3, tag: 2, folder: 5,
};

const LINK_STYLE: Record<string, { color: string; dash?: number[] }> = {
  parent:         { color: 'rgba(148,163,184,0.35)' },
  wiki:           { color: 'rgba(125,211,252,0.45)' },
  tag:            { color: 'rgba(192,132,252,0.25)', dash: [2, 2] },
  'session-note': { color: 'rgba(34,197,94,0.6)',   dash: [4, 2] },
  folder:         { color: 'rgba(71,85,105,0.3)' },
};

export function create2dBackend(): GraphBackend {
  let fg: InstanceType<typeof ForceGraph> | null = null;
  let clickCb: ((id: string) => void) | null = null;
  let fitted = false;

  // Interaction state.
  let searchLower = '';
  let selected: string | null = null;
  let neighborIds = new Set<string>();
  let lastData: GraphData = { nodes: [], links: [] };

  // Node-object cache for position persistence: reuse objects across update() calls
  // so d3's x/y/vx/vy survive vault saves without re-initialising.
  // Instance-scoped so simultaneous widget + fullscreen backends don't share state.
  const nodeCache = new Map<string, any>();

  function materialize(nodes: UnifiedNode[]): any[] {
    const seen = new Set<string>();
    const out = nodes.map((n) => {
      seen.add(n.id);
      const cached = nodeCache.get(n.id);
      if (cached) {
        // Mutate non-positional fields only; x/y/vx/vy are left intact.
        Object.assign(cached, n);
        return cached;
      }
      const fresh = { ...n };
      nodeCache.set(n.id, fresh);
      return fresh;
    });
    // Drop stale entries for nodes no longer present.
    for (const id of [...nodeCache.keys()]) {
      if (!seen.has(id)) nodeCache.delete(id);
    }
    return out;
  }

  function recomputeNeighbors(): void {
    neighborIds = new Set<string>();
    if (selected === null) return;
    neighborIds.add(selected);
    for (const l of lastData.links) {
      // force-graph mutates link endpoints into node objects after first render;
      // resolve ids defensively.
      const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (s === selected) neighborIds.add(t as string);
      if (t === selected) neighborIds.add(s as string);
    }
  }

  function nodeDimmed(n: any): boolean {
    if (searchLower !== '' &&
        !String(n.label ?? '').toLowerCase().includes(searchLower) &&
        !String(n.id ?? '').toLowerCase().includes(searchLower)) {
      return true;
    }
    if (selected !== null && !neighborIds.has(n.id)) {
      return true;
    }
    return false;
  }

  // Re-setting any accessor triggers a canvas redraw in force-graph
  // WITHOUT re-running the simulation (graphData() would reheat layout).
  function refresh(): void {
    if (!fg) return;
    fg.nodeColor(fg.nodeColor());
  }

  return {
    mount(el) {
      fg = new ForceGraph(el)
        .backgroundColor('#0b0f17')
        .nodeId('id')
        .nodeLabel('label') // hover tooltip
        .nodeRelSize(5)
        .nodeVal((n: any) => (SIZE[n.kind] ?? 3) + Math.min(n.degree ?? 0, 10) * 0.4)
        .nodeColor((n: any) => {
          if (nodeDimmed(n)) return 'rgba(100,116,139,0.15)';
          return COLOR[n.status] ?? KIND_COLOR[n.kind] ?? '#64748b';
        })
        .nodeCanvasObjectMode(() => 'after')
        .nodeCanvasObject((n: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
          // Always draw label for the selected node; skip dimmed nodes;
          // otherwise only draw when zoomed in enough to be readable.
          if (n.id !== selected) {
            if (nodeDimmed(n)) return;
            if (globalScale < 1.1) return;
          }
          const label = String(n.label ?? n.id);
          const fontSize = Math.max(11 / globalScale, 2);
          ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          ctx.fillStyle = 'rgba(203,213,225,0.92)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(label, n.x, n.y + 5);
        })
        .linkColor((l: any) => {
          // Dim links when a node is selected and neither endpoint is in the neighborhood.
          if (selected !== null) {
            const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
            const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
            if (!neighborIds.has(s as string) && !neighborIds.has(t as string)) {
              return 'rgba(100,116,139,0.08)';
            }
          }
          const type = typeof l.type === 'string' ? l.type : 'parent';
          return (LINK_STYLE[type] ?? LINK_STYLE.parent).color;
        })
        .linkLineDash((l: any) => {
          const t = typeof l.type === 'string' ? l.type : 'parent';
          return (LINK_STYLE[t] ?? LINK_STYLE.parent).dash ?? null;
        })
        .linkWidth(1)
        .onNodeClick((n: any) => {
          selected = n.id;
          recomputeNeighbors();
          refresh();
          clickCb?.(n.id);
        })
        .onBackgroundClick(() => {
          selected = null;
          recomputeNeighbors();
          refresh();
        });
    },
    update(data: GraphData) {
      lastData = data;
      // Selection upkeep: clear if the node vanished; either way links may have
      // changed, so recompute the neighborhood while a selection exists.
      if (selected !== null) {
        if (!data.nodes.some((n) => n.id === selected)) selected = null;
        recomputeNeighbors();
      }
      fg?.graphData({ nodes: materialize(data.nodes), links: data.links });
      // Fit the view to the graph once, shortly after the first data arrives.
      if (fg && !fitted && data.nodes.length > 0) {
        fitted = true;
        setTimeout(() => fg?.zoomToFit(500, 60), 600);
      }
    },
    refresh(data: GraphData) {
      // Topology is unchanged — sync fields into cached node objects and repaint
      // without calling graphData() (which would reheat the force simulation).
      lastData = data;
      materialize(data.nodes);
      if (selected !== null) {
        if (!data.nodes.some((n) => n.id === selected)) selected = null;
        recomputeNeighbors();
      }
      if (fg) fg.nodeColor(fg.nodeColor());
    },
    setSearch(q: string) {
      searchLower = q.toLowerCase();
      refresh();
    },
    setSelected(id: string | null) {
      selected = id;
      recomputeNeighbors();
      refresh();
    },
    setMode() { /* 2D backend ignores; surface re-instantiates on mode swap */ },
    destroy() {
      fg?._destructor?.();
      fg = null;
      nodeCache.clear();
    },
    on(_e, cb) { clickCb = cb; },
  };
}
