import { appState } from '../../state.js';
import { getOrCreateSleepyPane, destroySleepyPane } from './sleepy-instance.js';

interface SleepyPaneInstance {
  sessionId: string;
  projectId: string;
  element: HTMLElement;
  destroy(): void;
}

const instances = new Map<string, SleepyPaneInstance>();

export function createSleepyPane(sessionId: string, projectId: string): void {
  if (instances.has(sessionId)) return;

  const project = appState.projects.find((p) => p.id === projectId);
  const session = project?.sessions.find((s) => s.id === sessionId);
  if (!project || !session) return;

  const el = getOrCreateSleepyPane(project, session);
  el.classList.add('hidden');

  const instance: SleepyPaneInstance = {
    sessionId,
    projectId,
    element: el,
    destroy() {
      destroySleepyPane(sessionId);
    },
  };
  instances.set(sessionId, instance);
}

export function attachSleepyToContainer(sessionId: string, container: HTMLElement): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.element.parentElement !== container) {
    container.appendChild(instance.element);
  }
}

export function showSleepyPane(sessionId: string, isSplit: boolean): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.element.classList.remove('hidden');
  instance.element.classList.toggle('split', isSplit);
}

export function hideAllSleepyPanes(): void {
  for (const instance of instances.values()) {
    instance.element.classList.add('hidden');
  }
}

export function destroySleepyPaneById(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instances.delete(sessionId);
  instance.destroy();
}

export function getSleepyInstance(sessionId: string): SleepyPaneInstance | undefined {
  return instances.get(sessionId);
}
