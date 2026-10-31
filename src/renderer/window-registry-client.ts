import type { WindowsSnapshot } from '../shared/window-types.js';
import { windowId } from './window-context.js';

/**
 * Renderer-side mirror of main's WindowRegistry: which sessions live in which
 * window, and this window's active tab. Window assignment is deliberately NOT
 * part of appState — main owns it; renderers only read.
 */
export function createRegistryClient(myWindowId: string) {
  let snapshot: WindowsSnapshot = { hostWindows: [] };
  let localActive: string | null = null;
  const listeners = new Set<() => void>();

  const detached = (): Set<string> => {
    const s = new Set<string>();
    for (const w of snapshot.hostWindows) for (const id of w.sessionIds) s.add(id);
    return s;
  };
  const myRecord = () => snapshot.hostWindows.find((w) => w.id === myWindowId);

  return {
    applyWindowsSnapshot(snap: WindowsSnapshot): void {
      snapshot = snap;
      const mine = myRecord();
      if (mine && (localActive === null || !mine.sessionIds.includes(localActive))) {
        localActive = mine.activeSessionId;
      }
      listeners.forEach((cb) => cb());
    },
    isSessionHostedHere(sessionId: string): boolean {
      if (myWindowId === 'primary') return !detached().has(sessionId);
      return myRecord()?.sessionIds.includes(sessionId) ?? false;
    },
    detachedSessionIds(): ReadonlySet<string> {
      return detached();
    },
    mySessionIds(): string[] {
      return [...(myRecord()?.sessionIds ?? [])];
    },
    myActiveSessionId(): string | null {
      return localActive ?? myRecord()?.activeSessionId ?? null;
    },
    setMyActiveSession(id: string | null): void {
      localActive = id;
      if (typeof window !== 'undefined') window.nightyard?.windows?.setActiveSession(id);
      listeners.forEach((cb) => cb());
    },
    onWindowsChanged(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const client = createRegistryClient(windowId);

export const applyWindowsSnapshot = client.applyWindowsSnapshot;
export const isSessionHostedHere = client.isSessionHostedHere;
export const detachedSessionIds = client.detachedSessionIds;
export const mySessionIds = client.mySessionIds;
export const myActiveSessionId = client.myActiveSessionId;
export const setMyActiveSession = client.setMyActiveSession;
export const onWindowsChanged = client.onWindowsChanged;

export async function initWindowRegistryClient(): Promise<void> {
  window.nightyard.windows.onChanged((snap) => applyWindowsSnapshot(snap as WindowsSnapshot));
  applyWindowsSnapshot((await window.nightyard.windows.getSnapshot()) as WindowsSnapshot);
}
