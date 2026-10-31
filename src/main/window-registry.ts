import { PRIMARY_WINDOW_ID, type SecondaryWindowRecord, type WindowBounds, type WindowsSnapshot } from '../shared/window-types';

/**
 * Pure registry of session-host windows and which sessions they own.
 * Sessions not present in any host window belong to the primary window.
 * No Electron imports — unit-testable.
 */
export class WindowRegistry {
  private hosts = new Map<string, SecondaryWindowRecord>();

  loadFrom(records: SecondaryWindowRecord[] | undefined): void {
    this.hosts.clear();
    for (const r of records ?? []) {
      this.hosts.set(r.id, { ...r, sessionIds: [...r.sessionIds] });
    }
  }

  serialize(): SecondaryWindowRecord[] {
    return [...this.hosts.values()].map((r) => ({ ...r, sessionIds: [...r.sessionIds] }));
  }

  snapshot(): WindowsSnapshot {
    return { hostWindows: this.serialize() };
  }

  createHost(id: string, bounds: WindowBounds): SecondaryWindowRecord {
    const rec: SecondaryWindowRecord = { id, sessionIds: [], activeSessionId: null, bounds };
    this.hosts.set(id, rec);
    return rec;
  }

  /** Remove a host; its sessions return to primary. Returns the sessions it held. */
  removeHost(id: string): string[] {
    const rec = this.hosts.get(id);
    if (!rec) return [];
    this.hosts.delete(id);
    return rec.sessionIds;
  }

  ownerOf(sessionId: string): string {
    for (const rec of this.hosts.values()) {
      if (rec.sessionIds.includes(sessionId)) return rec.id;
    }
    return PRIMARY_WINDOW_ID;
  }

  /** Assign to a host window (removing from any other), optionally at an index. */
  assign(sessionId: string, windowId: string, index?: number): void {
    this.release(sessionId);
    const rec = this.hosts.get(windowId);
    if (!rec) return;
    const at = index === undefined ? rec.sessionIds.length : Math.max(0, Math.min(index, rec.sessionIds.length));
    rec.sessionIds.splice(at, 0, sessionId);
    if (!rec.activeSessionId) rec.activeSessionId = sessionId;
  }

  /** Remove from any host window (session returns to primary). */
  release(sessionId: string): void {
    for (const rec of this.hosts.values()) {
      const i = rec.sessionIds.indexOf(sessionId);
      if (i !== -1) {
        rec.sessionIds.splice(i, 1);
        if (rec.activeSessionId === sessionId) {
          rec.activeSessionId = rec.sessionIds[Math.min(i, rec.sessionIds.length - 1)] ?? null;
        }
      }
    }
  }

  setActiveSession(windowId: string, sessionId: string | null): void {
    const rec = this.hosts.get(windowId);
    if (!rec) return;
    if (sessionId !== null && !rec.sessionIds.includes(sessionId)) return;
    rec.activeSessionId = sessionId;
  }

  setBounds(windowId: string, bounds: WindowBounds): void {
    const rec = this.hosts.get(windowId);
    if (rec) rec.bounds = bounds;
  }

  sessionsOf(windowId: string): string[] {
    return [...(this.hosts.get(windowId)?.sessionIds ?? [])];
  }

  hasHost(windowId: string): boolean {
    return this.hosts.has(windowId);
  }

  emptyHosts(): string[] {
    return [...this.hosts.values()].filter((r) => r.sessionIds.length === 0).map((r) => r.id);
  }

  /** Drop sessions that no longer exist. Returns host ids that became empty. */
  pruneToSessions(validIds: Set<string>): string[] {
    const emptied: string[] = [];
    for (const rec of this.hosts.values()) {
      const before = rec.sessionIds.length;
      rec.sessionIds = rec.sessionIds.filter((id) => validIds.has(id));
      if (rec.activeSessionId && !validIds.has(rec.activeSessionId)) {
        rec.activeSessionId = rec.sessionIds[0] ?? null;
      }
      if (before > 0 && rec.sessionIds.length === 0) emptied.push(rec.id);
    }
    return emptied;
  }
}
