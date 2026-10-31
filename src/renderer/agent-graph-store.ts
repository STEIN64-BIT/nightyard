export type NodeKind = 'project' | 'session' | 'subagent' | 'tool';
export type NodeStatus = 'working' | 'waiting' | 'input' | 'idle' | 'completed';
export type ProjectStatus = 'working' | 'attention' | 'idle';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  label: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  lastEventAt: number;
}

export type GraphEvent =
  | { kind: 'upsert-project'; id: string; label: string }
  | { kind: 'remove-project'; id: string }
  | { kind: 'upsert-session'; id: string; parentId: string; label: string; status: NodeStatus }
  | { kind: 'remove-session'; id: string }
  | { kind: 'session-status'; id: string; status: NodeStatus }
  | { kind: 'session-label'; id: string; label: string }
  | { kind: 'subagent-start'; id: string; parentId: string; label: string }
  | { kind: 'subagent-stop'; id: string }
  | { kind: 'tool'; id: string; parentId: string; label: string };

const LINGER_MS = 4000;
const STALE_MS = 5 * 60 * 1000;

const nodes = new Map<string, GraphNode>();
const listeners: Array<() => void> = [];

// In production `now` defaults to wall-clock time. Tests reset this to a fixed
// origin (0) so that explicit timestamps passed to getGraph/sweep/getProjectStatus
// are consistent with the timestamps stamped on nodes by applyEvent.
let clockOrigin: number | null = null;
function clockNow(): number {
  return clockOrigin ?? Date.now();
}

function notify() { for (const cb of listeners) cb(); }

function upsert(id: string, kind: NodeKind, parentId: string | null, label: string, status: NodeStatus, now: number) {
  const existing = nodes.get(id);
  if (existing) {
    existing.label = label;
    existing.parentId = parentId;
    existing.lastEventAt = now;
    existing.status = status;
  } else {
    nodes.set(id, { id, kind, parentId, label, status, startedAt: now, lastEventAt: now });
  }
}

function removeCascade(id: string) {
  nodes.delete(id);
  for (const n of [...nodes.values()]) {
    if (n.parentId === id) removeCascade(n.id);
  }
}

export function applyEvent(ev: GraphEvent, now: number = clockNow()): void {
  switch (ev.kind) {
    case 'upsert-project': upsert(ev.id, 'project', null, ev.label, 'idle', now); break;
    case 'remove-project': removeCascade(ev.id); break;
    case 'upsert-session': upsert(ev.id, 'session', ev.parentId, ev.label, ev.status, now); break;
    case 'remove-session': removeCascade(ev.id); break;
    case 'session-status': { const n = nodes.get(ev.id); if (n) { n.status = ev.status; n.lastEventAt = now; } break; }
    case 'session-label': { const n = nodes.get(ev.id); if (n) { n.label = ev.label; n.lastEventAt = now; } break; }
    case 'subagent-start': upsert(ev.id, 'subagent', ev.parentId, ev.label, 'working', now); break;
    case 'subagent-stop': { const n = nodes.get(ev.id); if (n) { n.status = 'completed'; n.endedAt = now; n.lastEventAt = now; } break; }
    case 'tool': upsert(ev.id, 'tool', ev.parentId, ev.label, 'working', now); break;
  }
  notify();
}

export function getGraph(now: number = clockNow()): GraphNode[] {
  return [...nodes.values()].filter(n => !(n.endedAt !== undefined && now - n.endedAt > LINGER_MS));
}

export function getProjectStatus(projectId: string, now: number = clockNow()): ProjectStatus {
  const visible = getGraph(now);
  const descendants = (id: string): GraphNode[] => {
    const kids = visible.filter(n => n.parentId === id);
    return kids.flatMap(k => [k, ...descendants(k.id)]);
  };
  const desc = descendants(projectId);
  if (desc.some(n => n.status === 'working')) return 'working';
  if (desc.some(n => n.status === 'input' || n.status === 'waiting')) return 'attention';
  return 'idle';
}

export function sweep(now: number = clockNow()): void {
  let changed = false;
  for (const n of nodes.values()) {
    if (n.status === 'working' && now - n.lastEventAt > STALE_MS) { n.status = 'idle'; changed = true; }
  }
  if (changed) notify();
}

export function onChange(cb: () => void): () => void {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); };
}

/** @internal Test-only */
export function _resetForTesting(): void {
  nodes.clear();
  listeners.length = 0;
  clockOrigin = 0;
}
