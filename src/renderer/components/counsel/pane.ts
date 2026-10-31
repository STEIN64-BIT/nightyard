import { instances, type CounselInstance } from './instance.js';
import { renderCounsel, teardownCounsel } from './counsel-view.js';

export function createCounselPane(sessionId: string, projectId: string): void {
  if (instances.has(sessionId)) return;

  const el = document.createElement('div');
  el.className = 'counsel-pane hidden';
  el.dataset['sessionId'] = sessionId;

  const instance: CounselInstance = {
    sessionId,
    projectId,
    element: el,
    destroy() {
      el.remove();
    },
  };
  instances.set(sessionId, instance);
}

export function attachCounselToContainer(sessionId: string, container: HTMLElement): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.element.parentElement !== container) {
    container.appendChild(instance.element);
  }
}

export function showCounselPane(sessionId: string, isSplit: boolean): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.element.classList.remove('hidden');
  instance.element.classList.toggle('split', isSplit);
  renderCounsel(instance.element, instance.projectId);
}

export function hideAllCounselPanes(): void {
  for (const instance of instances.values()) {
    instance.element.classList.add('hidden');
  }
}

export function destroyCounselPane(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instances.delete(sessionId);
  teardownCounsel(instance.element);
  instance.destroy();
}

export { getCounselInstance } from './instance.js';
