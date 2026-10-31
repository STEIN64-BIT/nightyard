import {
  applyEvent, getGraph, getProjectStatus, onChange, sweep, _resetForTesting,
} from './agent-graph-store';

beforeEach(() => { _resetForTesting(); });

describe('node lifecycle', () => {
  it('adds project and session nodes', () => {
    applyEvent({ kind: 'upsert-project', id: 'p1', label: 'Demo' });
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 'sess', status: 'working' });
    const g = getGraph(1000);
    expect(g.map(n => n.id).sort()).toEqual(['p1', 's1']);
    expect(g.find(n => n.id === 's1')!.parentId).toBe('p1');
  });

  it('adds a subagent under a session and removes it after linger', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 'sess', status: 'working' });
    applyEvent({ kind: 'subagent-start', id: 'a1', parentId: 's1', label: 'Explore' });
    expect(getGraph(1000).some(n => n.id === 'a1')).toBe(true);
    applyEvent({ kind: 'subagent-stop', id: 'a1' });
    expect(getGraph(2000).some(n => n.id === 'a1')).toBe(true);
    expect(getGraph(2000 + 4001).some(n => n.id === 'a1')).toBe(false);
  });

  it('subagent-stop with no matching start is a no-op', () => {
    expect(() => applyEvent({ kind: 'subagent-stop', id: 'ghost' })).not.toThrow();
    expect(getGraph(1000)).toEqual([]);
  });

  it('removing a session cascades to its children', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 'sess', status: 'working' });
    applyEvent({ kind: 'subagent-start', id: 'a1', parentId: 's1', label: 'Explore' });
    applyEvent({ kind: 'remove-session', id: 's1' });
    const ids = getGraph(1000).map(n => n.id);
    expect(ids).not.toContain('s1');
    expect(ids).not.toContain('a1');
  });
});

describe('getProjectStatus', () => {
  beforeEach(() => { applyEvent({ kind: 'upsert-project', id: 'p1', label: 'P' }); });
  it('working if any descendant is working', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 's', status: 'idle' });
    applyEvent({ kind: 'subagent-start', id: 'a1', parentId: 's1', label: 'a' });
    applyEvent({ kind: 'session-status', id: 's1', status: 'working' });
    expect(getProjectStatus('p1', 1000)).toBe('working');
  });
  it('attention if any descendant waits/needs input but none working', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 's', status: 'input' });
    expect(getProjectStatus('p1', 1000)).toBe('attention');
  });
  it('idle otherwise', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 's', status: 'idle' });
    expect(getProjectStatus('p1', 1000)).toBe('idle');
  });
});

describe('sweep', () => {
  it('marks a stale working node idle after 5 minutes', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 's', status: 'working' });
    sweep(5 * 60 * 1000 + 1);
    expect(getGraph(5 * 60 * 1000 + 2).find(n => n.id === 's1')!.status).toBe('idle');
  });
});

describe('onChange', () => {
  it('notifies listeners on apply', () => {
    const cb = vi.fn();
    onChange(cb);
    applyEvent({ kind: 'upsert-project', id: 'p1', label: 'P' });
    expect(cb).toHaveBeenCalled();
  });
});

describe('session-label', () => {
  it('updates the label of an existing session in place', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 'Session 1', status: 'working' });
    applyEvent({ kind: 'session-label', id: 's1', label: 'Fix graph orbs' });
    const n = getGraph(1000).find((x) => x.id === 's1')!;
    expect(n.label).toBe('Fix graph orbs');
    expect(n.status).toBe('working'); // status untouched
  });

  it('is a no-op for unknown session ids', () => {
    expect(() => applyEvent({ kind: 'session-label', id: 'ghost', label: 'x' })).not.toThrow();
    expect(getGraph(1000)).toEqual([]);
  });

  it('notifies listeners', () => {
    applyEvent({ kind: 'upsert-session', id: 's1', parentId: 'p1', label: 'a', status: 'idle' });
    const cb = vi.fn();
    onChange(cb);
    applyEvent({ kind: 'session-label', id: 's1', label: 'b' });
    expect(cb).toHaveBeenCalled();
  });
});
