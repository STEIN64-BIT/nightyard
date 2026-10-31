import { appState } from '../state.js';
import { mountOverviewGrid } from './project-tab/grid.js';
import type { OverviewLayout } from '../../shared/types.js';

/** Default cross-project overview: a single agent-graph widget. */
function defaultGlobalLayout(): OverviewLayout {
  return {
    gridVersion: 1,
    widgets: [{ id: 'graph-1', type: 'agent-graph', x: 0, y: 0, w: 12, h: 12 }],
  };
}

/**
 * Mount the app-scoped "All Projects" overview into `container`. Reuses the
 * same gridstack rendering as the per-project overview (via mountOverviewGrid),
 * but reads/writes the top-level `appState.globalOverview` layout instead of a
 * project's `overviewLayout`.
 *
 * @returns a teardown function that destroys the grid.
 */
export function mountGlobalOverview(container: HTMLElement): () => void {
  const root = document.createElement('div');
  root.className = 'project-tab-grid-root';
  container.appendChild(root);

  const mounted = mountOverviewGrid(root, {
    getLayout(): OverviewLayout {
      const existing = appState.globalOverview;
      if (existing && existing.widgets.length > 0) return existing;
      return defaultGlobalLayout();
    },
    saveLayout(layout: OverviewLayout): void {
      appState.setGlobalOverview(layout);
    },
  });

  return () => {
    mounted.destroy();
    root.remove();
  };
}

/**
 * Open the "All Projects" overview as a full-screen overlay (same overlay
 * pattern the fullscreen graph view uses). Returns immediately; the overlay
 * tears itself down on close.
 */
export function openGlobalOverview(): void {
  // Single-instance: don't stack overlays.
  if (document.querySelector('.vy-global-overview-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'vy-graph-overlay vy-global-overview-overlay';
  overlay.tabIndex = 0;

  const controls = document.createElement('div');
  controls.className = 'vy-graph-controls';
  const title = document.createElement('span');
  title.textContent = 'All Projects';
  title.style.fontWeight = '600';
  const close = document.createElement('button');
  close.textContent = 'Close';
  controls.append(title, close);

  const surface = document.createElement('div');
  surface.className = 'vy-graph-surface';
  overlay.append(controls, surface);
  document.body.appendChild(overlay);
  overlay.focus();

  const teardownGrid = mountGlobalOverview(surface);

  function teardown(): void {
    teardownGrid();
    overlay.remove();
  }

  close.addEventListener('click', teardown);
  overlay.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') teardown();
  });
}
