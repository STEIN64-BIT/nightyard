import { describe, it, expect } from 'vitest';
import { createRegistryClient } from './window-registry-client';

const snap = {
  hostWindows: [
    { id: 'w1', sessionIds: ['a', 'b'], activeSessionId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1 } },
  ],
};

describe('window registry client', () => {
  it('primary window: hosted-here means not detached anywhere', () => {
    const c = createRegistryClient('primary');
    c.applyWindowsSnapshot(snap);
    expect(c.isSessionHostedHere('a')).toBe(false);
    expect(c.isSessionHostedHere('zzz')).toBe(true);
    expect([...c.detachedSessionIds()]).toEqual(['a', 'b']);
  });

  it('host window: hosted-here means in my list, in order', () => {
    const c = createRegistryClient('w1');
    c.applyWindowsSnapshot(snap);
    expect(c.isSessionHostedHere('a')).toBe(true);
    expect(c.isSessionHostedHere('zzz')).toBe(false);
    expect(c.mySessionIds()).toEqual(['a', 'b']);
    expect(c.myActiveSessionId()).toBe('a');
  });

  it('setMyActiveSession updates local view immediately', () => {
    const c = createRegistryClient('w1');
    c.applyWindowsSnapshot(snap);
    c.setMyActiveSession('b');
    expect(c.myActiveSessionId()).toBe('b');
  });

  it('drops local active when the session leaves this window', () => {
    const c = createRegistryClient('w1');
    c.applyWindowsSnapshot(snap);
    c.setMyActiveSession('b');
    c.applyWindowsSnapshot({
      hostWindows: [
        { id: 'w1', sessionIds: ['a'], activeSessionId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    });
    expect(c.myActiveSessionId()).toBe('a');
  });

  it('notifies listeners on snapshot apply', () => {
    const c = createRegistryClient('primary');
    let calls = 0;
    c.onWindowsChanged(() => calls++);
    c.applyWindowsSnapshot(snap);
    expect(calls).toBe(1);
  });
});
