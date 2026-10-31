import { appState } from './state.js';
import { onChange as onStatusChange, getStatus, type SessionStatus } from './session-activity.js';
import { isPrimaryWindow } from './window-context.js';
import { isSessionHostedHere, myActiveSessionId, onWindowsChanged } from './window-registry-client.js';

type UnreadChangeCallback = () => void;

const unreadSessions = new Set<string>();
const listeners: UnreadChangeCallback[] = [];
const prevStatus = new Map<string, SessionStatus>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function init(): void {
  onStatusChange((sessionId, status) => {
    const prev = prevStatus.get(sessionId);
    prevStatus.set(sessionId, status);

    if (prev === 'working' && (status === 'waiting' || status === 'completed' || status === 'input')) {
      // Only the window hosting the session shows its unread dot.
      if (!isSessionHostedHere(sessionId)) return;
      const viewing = isPrimaryWindow()
        ? (() => {
            const project = appState.projects.find(p => p.sessions.some(s => s.id === sessionId));
            return !!project && sessionId === project.activeSessionId && project.id === appState.activeProjectId;
          })()
        : sessionId === myActiveSessionId();
      if (!viewing) {
        unreadSessions.add(sessionId);
        notify();
      }
    }
  });

  appState.on('session-changed', () => {
    const project = appState.activeProject;
    if (project && unreadSessions.has(project.activeSessionId)) {
      unreadSessions.delete(project.activeSessionId);
      notify();
    }
  });

  // Host windows: switching tabs clears that tab's unread dot.
  onWindowsChanged(() => {
    const active = myActiveSessionId();
    if (active && unreadSessions.delete(active)) notify();
  });

  appState.on('session-removed', (data?: unknown) => {
    const d = data as { sessionId?: string } | undefined;
    if (d?.sessionId) {
      removeSession(d.sessionId);
    }
  });
}

export function isUnread(sessionId: string): boolean {
  return unreadSessions.has(sessionId);
}

export function hasUnreadInProject(projectId: string): boolean {
  const project = appState.projects.find(p => p.id === projectId);
  if (!project) return false;
  return project.sessions.some(s => unreadSessions.has(s.id));
}

export function removeSession(sessionId: string): void {
  if (unreadSessions.delete(sessionId)) {
    prevStatus.delete(sessionId);
    notify();
  } else {
    prevStatus.delete(sessionId);
  }
}

export function onChange(callback: UnreadChangeCallback): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  unreadSessions.clear();
  listeners.length = 0;
  prevStatus.clear();
}
