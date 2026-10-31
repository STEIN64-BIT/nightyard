import { describe, it, expect } from 'vitest';
import { WindowRegistry } from './window-registry';

const bounds = { x: 10, y: 10, width: 800, height: 600 };

describe('WindowRegistry', () => {
  it('reports primary as owner for unassigned sessions', () => {
    const reg = new WindowRegistry();
    expect(reg.ownerOf('s1')).toBe('primary');
  });

  it('assigns a session to a host window and back', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.assign('s1', 'w1');
    expect(reg.ownerOf('s1')).toBe('w1');
    expect(reg.sessionsOf('w1')).toEqual(['s1']);
    reg.release('s1');
    expect(reg.ownerOf('s1')).toBe('primary');
    expect(reg.sessionsOf('w1')).toEqual([]);
  });

  it('assign moves a session between hosts and respects index', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.createHost('w2', bounds);
    reg.assign('s1', 'w1');
    reg.assign('s2', 'w2');
    reg.assign('s3', 'w2');
    reg.assign('s1', 'w2', 1);
    expect(reg.sessionsOf('w1')).toEqual([]);
    expect(reg.sessionsOf('w2')).toEqual(['s2', 's1', 's3']);
  });

  it('removeHost returns its sessions (they go back to primary)', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.assign('s1', 'w1');
    reg.assign('s2', 'w1');
    expect(reg.removeHost('w1')).toEqual(['s1', 's2']);
    expect(reg.ownerOf('s1')).toBe('primary');
    expect(reg.serialize()).toEqual([]);
  });

  it('setActiveSession falls back to null when the active session leaves', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.assign('s1', 'w1');
    reg.setActiveSession('w1', 's1');
    reg.release('s1');
    expect(reg.serialize()[0].activeSessionId).toBe(null);
  });

  it('emptyHosts lists hosts with no sessions', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.createHost('w2', bounds);
    reg.assign('s1', 'w2');
    expect(reg.emptyHosts()).toEqual(['w1']);
  });

  it('pruneToSessions drops unknown sessions and reports now-empty hosts', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.assign('gone', 'w1');
    reg.createHost('w2', bounds);
    reg.assign('kept', 'w2');
    const emptied = reg.pruneToSessions(new Set(['kept']));
    expect(emptied).toEqual(['w1']);
    expect(reg.ownerOf('gone')).toBe('primary');
  });

  it('serialize/loadFrom round-trips', () => {
    const reg = new WindowRegistry();
    reg.createHost('w1', bounds);
    reg.assign('s1', 'w1');
    reg.setActiveSession('w1', 's1');
    reg.setBounds('w1', { x: 1, y: 2, width: 3, height: 4 });
    const reg2 = new WindowRegistry();
    reg2.loadFrom(reg.serialize());
    expect(reg2.serialize()).toEqual(reg.serialize());
    expect(reg2.ownerOf('s1')).toBe('w1');
  });
});
