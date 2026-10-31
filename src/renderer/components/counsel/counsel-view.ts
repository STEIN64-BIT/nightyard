import { getActiveCounsel, onCounselChange } from '../../counsel-store.js';
import { renderStartView, resetStartView } from './start-view.js';
import { renderDebate } from './debate-view.js';

const subscriptions = new Map<HTMLElement, () => void>();

/**
 * Router between the start view and the debate view for a project's Counsel
 * pane. There is exactly one global active counsel (counsel-store.ts is a
 * singleton) — so a project shows the debate view whenever that active
 * counsel belongs to it, and the start view otherwise (including the case
 * where a *different* project's debate is running).
 */
export function renderCounsel(root: HTMLElement, projectId: string): void {
  subscriptions.get(root)?.();

  const paint = (): void => {
    const active = getActiveCounsel();
    if (active && active.projectId === projectId) {
      // Custom-select instances attach document-level listeners that survive
      // a plain innerHTML wipe — destroy them before handing the root over.
      resetStartView(root);
      renderDebate(root, active);
    } else {
      renderStartView(root, projectId);
    }
  };

  const unsubscribe = onCounselChange(paint);
  subscriptions.set(root, unsubscribe);
  paint();
}

/**
 * Unsubscribes the store listener registered for `root` by `renderCounsel`.
 * Must be called when a Counsel pane is destroyed (tab close) — otherwise
 * the store's `listeners` Set holds `paint` (and, through its closure, the
 * detached `root`) forever, and every future store notification keeps
 * repainting a DOM node no one can see.
 */
export function teardownCounsel(root: HTMLElement): void {
  subscriptions.get(root)?.();
  subscriptions.delete(root);
}
