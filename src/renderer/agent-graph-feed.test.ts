import { inspectorEventToGraphEvents } from './agent-graph-feed';
import type { InspectorEvent } from '../shared/types';

function ev(partial: Partial<InspectorEvent>): InspectorEvent {
  return { type: 'notification', timestamp: 0, hookEvent: '', ...partial } as InspectorEvent;
}

describe('inspectorEventToGraphEvents', () => {
  it('maps subagent_start to subagent-start with agent_type label', () => {
    const out = inspectorEventToGraphEvents('s1', ev({ type: 'subagent_start', agent_id: 'a1', agent_type: 'Explore' }));
    expect(out).toEqual([{ kind: 'subagent-start', id: 'a1', parentId: 's1', label: 'Explore' }]);
  });

  it('maps subagent_stop to subagent-stop', () => {
    const out = inspectorEventToGraphEvents('s1', ev({ type: 'subagent_stop', agent_id: 'a1' }));
    expect(out).toEqual([{ kind: 'subagent-stop', id: 'a1' }]);
  });

  it('maps tool_use to a tool node keyed by timestamp', () => {
    const out = inspectorEventToGraphEvents('s1', ev({ type: 'tool_use', tool_name: 'Bash', timestamp: 42 }));
    expect(out).toEqual([{ kind: 'tool', id: 's1:tool:42', parentId: 's1', label: 'Bash' }]);
  });

  it('ignores events without the data it needs', () => {
    expect(inspectorEventToGraphEvents('s1', ev({ type: 'subagent_start' }))).toEqual([]);
    expect(inspectorEventToGraphEvents('s1', ev({ type: 'notification' }))).toEqual([]);
  });
});
