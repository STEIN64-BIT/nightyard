import type { VaultGraph } from '../shared/types.js';
import { parentLinks, type UnifiedLink, type UnifiedNode } from './graph-renderer/index.js';

export interface SessionNoteLink { sessionId: string; noteId: string; }

export function mergeGraphs(
  vault: VaultGraph,
  agentNodes: UnifiedNode[],
  sessionNotes: SessionNoteLink[],
): { nodes: UnifiedNode[]; links: UnifiedLink[] } {
  const links: UnifiedLink[] = vault.links.map((l) => ({ ...l }));
  // degree = note-to-note wiki-link degree only (Obsidian-style); tag/session links don't count
  const degree = new Map<string, number>();
  for (const l of vault.links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const nodes: UnifiedNode[] = vault.notes.map((n) => ({
    id: n.id, kind: 'note', label: n.title, parentId: null, degree: degree.get(n.id) ?? 0,
  }));
  const tags = new Set(vault.notes.flatMap((n) => n.tags));
  for (const t of tags) nodes.push({ id: `tag:${t}`, kind: 'tag', label: `#${t}`, parentId: null });
  for (const n of vault.notes) for (const t of n.tags) links.push({ source: n.id, target: `tag:${t}`, type: 'tag' });

  nodes.push(...agentNodes);
  // dangling parent links (lingered-out parents) are tolerated: createGraphRenderer filters links to visible nodes
  links.push(...parentLinks(agentNodes));
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const sn of sessionNotes) {
    if (nodeIds.has(sn.noteId) && nodeIds.has(sn.sessionId)) {
      links.push({ source: sn.noteId, target: sn.sessionId, type: 'session-note' });
    }
  }
  return { nodes, links };
}
