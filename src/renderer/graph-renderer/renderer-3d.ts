import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import SpriteText from 'three-spritetext';
import type { GraphBackend, GraphData, UnifiedNode } from './index.js';

let webglSupport: boolean | null = null;

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

const LINK_COLOR: Record<string, string> = {
  parent: 'rgba(148,163,184,0.35)', wiki: 'rgba(125,211,252,0.5)',
  tag: 'rgba(192,132,252,0.3)', 'session-note': 'rgba(34,197,94,0.7)', folder: 'rgba(71,85,105,0.3)',
};

/** Returns null if WebGL is unavailable (caller falls back to 2D). */
export function create3dBackend(): GraphBackend | null {
  if (webglSupport === null) {
    const canvas = document.createElement('canvas');
    webglSupport = !!(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  }
  if (!webglSupport) return null;

  let fg: ForceGraph3DInstance | null = null;
  let clickCb: ((id: string) => void) | null = null;
  let fitted = false;

  // Interaction state.
  let searchLower = '';
  let selected: string | null = null;
  let neighborIds = new Set<string>();
  let lastData: GraphData = { nodes: [], links: [] };

  // Node-object cache for position persistence: reuse objects across update() calls
  // so the force simulation's x/y/z/vx/vy/vz survive vault saves without re-initialising.
  // Instance-scoped so simultaneous widget + fullscreen backends don't share state.
  const nodeCache = new Map<string, any>();

  function materialize(nodes: UnifiedNode[]): any[] {
    const seen = new Set<string>();
    const out = nodes.map((n) => {
      seen.add(n.id);
      const cached = nodeCache.get(n.id);
      if (cached) {
        // Mutate non-positional fields only; x/y/z/vx/vy/vz are left intact.
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
      // 3d-force-graph mutates link endpoints into node objects after first render;
      // resolve ids defensively.
      const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (s === selected) neighborIds.add(t as string);
      if (t === selected) neighborIds.add(s as string);
    }
  }

  function dimmed(n: any): boolean {
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

  // ThreeForceGraphGeneric exposes refresh() which re-evaluates all accessors
  // (node color, sprite objects, link color) WITHOUT re-heating the force simulation.
  function refresh(): void {
    fg?.refresh();
  }

  function flyTo(node: any): void {
    if (!fg) return;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) return;
    const dist = 120;
    const len = Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
    const ratio = 1 + dist / len;
    fg.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      node,
      800,
    );
  }

  return {
    mount(el) {
      fg = new ForceGraph3D(el)
        .backgroundColor('#0b0f17')
        .nodeId('id')
        .nodeLabel('label') // hover tooltip
        .nodeVal((n: any) => (SIZE[n.kind] ?? 3) + Math.min(n.degree ?? 0, 10) * 0.4)
        .nodeColor((n: any) => dimmed(n) ? 'rgba(100,116,139,0.12)' : (COLOR[n.status] ?? KIND_COLOR[n.kind] ?? '#64748b'))
        .nodeThreeObjectExtend(true)
        .nodeThreeObject((n: any): any => {
          // Sprite labels always face the camera.
          // Only render for non-dimmed, important-enough nodes to keep the scene readable.
          if (dimmed(n)) return null;
          const big = (n.degree ?? 0) > 2 || n.kind === 'project' || n.kind === 'folder' || n.id === selected;
          if (!big && n.kind !== 'session') return null;
          const sprite = new SpriteText(String(n.label ?? n.id).slice(0, 28));
          sprite.color = 'rgba(203,213,225,0.95)';
          sprite.textHeight = n.id === selected ? 5 : 3.2;
          // Position label below the node sphere.
          // Cast needed: three ships no .d.ts so Sprite's inherited Object3D.position isn't typed.
          (sprite as any).position.set(0, -((SIZE[n.kind] ?? 3) + 4), 0);
          return sprite;
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
          return LINK_COLOR[type] ?? LINK_COLOR.parent;
        })
        .linkWidth((l: any) => (l.type === 'session-note' ? 1.5 : 0.5))
        .onNodeClick((n: any) => { selected = n.id; recomputeNeighbors(); refresh(); flyTo(n); clickCb?.(n.id); })
        .onBackgroundClick(() => { selected = null; recomputeNeighbors(); refresh(); })
        .warmupTicks(60) // pre-settle layout off-screen: no exploding-jelly intro
        .cooldownTicks(200);
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
      // Fit the camera to the graph once, shortly after the first data arrives.
      if (fg && !fitted && data.nodes.length > 0) {
        fitted = true;
        // After the initial settled intro, disable sync warmup ticks so that
        // subsequent topology changes animate rather than stalling 60 frames.
        setTimeout(() => {
          fg?.zoomToFit(700, 80);
          fg?.warmupTicks(0);
        }, 800);
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
      fg?.refresh();
    },
    setSearch(q: string) {
      if (q.toLowerCase() === searchLower) return;
      searchLower = q.toLowerCase();
      refresh();
    },
    setSelected(id: string | null) {
      if (id === selected) return;
      selected = id;
      recomputeNeighbors();
      refresh();
      if (id !== null) {
        const node = fg?.graphData().nodes.find((n: any) => n.id === id);
        if (node) flyTo(node);
      }
    },
    setMode() { /* 3D backend ignores; surface re-instantiates on mode swap */ },
    destroy() {
      fg?._destructor?.();
      fg = null;
      nodeCache.clear();
    },
    on(_e, cb) { clickCb = cb; },
  };
}
