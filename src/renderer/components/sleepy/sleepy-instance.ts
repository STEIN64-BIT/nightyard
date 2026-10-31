import { buildSleepyPane } from './sleepy-pane.js';
import type { SleepyPaneHandle } from './sleepy-pane.js';
import type { ProjectRecord, SessionRecord } from '../../../shared/types.js';

const sleepyPanes = new Map<string, SleepyPaneHandle>();

export function getOrCreateSleepyPane(project: ProjectRecord, session: SessionRecord): HTMLElement {
  let handle = sleepyPanes.get(session.id);
  if (!handle) {
    handle = buildSleepyPane(project, session);
    sleepyPanes.set(session.id, handle);
  }
  return handle.pane;
}

export function destroySleepyPane(sessionId: string): void {
  const handle = sleepyPanes.get(sessionId);
  if (handle) {
    handle.unsubGoal();
    handle.pane.remove();
    sleepyPanes.delete(sessionId);
  }
  window.nightyard.sleepy.kill(sessionId).catch(() => {});
}
