import type { InspectorEvent } from '../shared/types.js';
import { applyEvent, type GraphEvent } from './agent-graph-store.js';

/** Pure: translate one inspector event for a session into store events. */
export function inspectorEventToGraphEvents(sessionId: string, ev: InspectorEvent): GraphEvent[] {
  switch (ev.type) {
    case 'subagent_start':
      if (!ev.agent_id) return [];
      return [{ kind: 'subagent-start', id: ev.agent_id, parentId: sessionId, label: ev.agent_type || 'Subagent' }];
    case 'subagent_stop':
      if (!ev.agent_id) return [];
      return [{ kind: 'subagent-stop', id: ev.agent_id }];
    case 'tool_use':
      if (!ev.tool_name) return [];
      return [{ kind: 'tool', id: `${sessionId}:tool:${ev.timestamp}`, parentId: sessionId, label: ev.tool_name }];
    default:
      return [];
  }
}

/** Push inspector events into the store (used by the live wiring in index.ts). */
export function feedInspectorEvents(sessionId: string, events: InspectorEvent[]): void {
  for (const ev of events) {
    for (const ge of inspectorEventToGraphEvents(sessionId, ev)) applyEvent(ge);
  }
}
