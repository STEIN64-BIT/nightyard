import { createGraphRenderer, parentLinks } from '../graph-renderer/index.js';
import { create2dBackend } from '../graph-renderer/renderer-2d.js';
import { getGraph, onChange } from '../agent-graph-store.js';
import { openGraphFullscreen } from './graph-fullscreen.js';
import type { WidgetFactory } from './project-tab/widgets/widget-host.js';

/** Renders a compact live graph into `container`. Returns a teardown function. */
export function renderAgentGraphWidget(container: HTMLElement): () => void {
  container.innerHTML = '';
  const surface = document.createElement('div');
  surface.style.width = '100%';
  surface.style.height = '100%';
  surface.style.cursor = 'pointer';
  surface.title = 'Click to open fullscreen';
  container.appendChild(surface);

  const renderer = createGraphRenderer({ backendFactory: create2dBackend });
  renderer.mount(surface);
  const g = getGraph();
  renderer.update(g, parentLinks(g));
  const onClick = () => openGraphFullscreen();
  surface.addEventListener('click', onClick);

  let raf = 0;
  const unsub = onChange(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; const g = getGraph(); renderer.update(g, parentLinks(g)); });
  });

  return () => {
    unsub();
    if (raf) cancelAnimationFrame(raf);
    surface.removeEventListener('click', onClick);
    renderer.destroy();
  };
}

/**
 * Widget-registry factory adapter. The Overview grid mounts widgets via the
 * registry's `WidgetFactory` contract (`(host) => { element, destroy }`), so we
 * bridge the standalone `renderAgentGraphWidget` teardown into `destroy()`.
 */
export const createAgentGraphWidget: WidgetFactory = () => {
  const element = document.createElement('div');
  element.className = 'widget-agent-graph';
  element.style.width = '100%';
  element.style.height = '100%';
  const teardown = renderAgentGraphWidget(element);
  return {
    element,
    destroy() {
      teardown();
    },
  };
};
