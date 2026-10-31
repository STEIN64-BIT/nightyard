import type { UnifiedNode } from '../graph-renderer/index.js';

export interface NodeDetailMetaRow { label: string; value: string; }

export interface NodeDetailOpts {
  /** First ~800 chars of the note body ('' for non-notes). */
  preview: string;
  /** Structured metadata rows (project, provider, status, …) shown under the title. */
  meta?: NodeDetailMetaRow[];
  onLaunch: (noteId: string) => void;
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
  /** Optional: jump to a live session's tab (session nodes only). */
  onGoToSession?: (sessionId: string) => void;
  /** Optional: launch a Wakey-supervised session from this note node. */
  onLaunchWakey?: (noteId: string) => void;
  /** Optional: open a Sleepy planning session for this note node. */
  onLaunchSleepy?: (noteId: string) => void;
}

/**
 * Render a side-panel showing node metadata and actions.
 *
 * SECURITY: `node.kind` is a closed union and safe to interpolate into
 * innerHTML. `node.label`, `opts.preview`, and all meta labels/values are
 * always assigned via `.textContent` — never interpolated — to prevent XSS.
 */
export function renderNodeDetail(node: UnifiedNode, opts: NodeDetailOpts): HTMLElement {
  const el = document.createElement('aside');
  el.className = 'node-detail';

  const isNote = node.kind === 'note';
  const isSession = node.kind === 'session';

  // Only node.kind (a closed union) is interpolated here — safe.
  el.innerHTML = `
    <header class="node-detail__header">
      <span class="node-detail__kind">${node.kind}</span>
      <h3 class="node-detail__title"></h3>
      <button class="node-detail__close" title="Close" aria-label="Close">×</button>
    </header>
    <dl class="node-detail__meta"></dl>
    <pre class="node-detail__preview"></pre>
    <footer class="node-detail__actions">
      ${isSession && opts.onGoToSession ? '<button class="node-detail__goto">↗ Go to session</button>' : ''}
      ${isNote ? '<button class="node-detail__launch">▶ Launch agent here</button>' : ''}
      ${isNote ? '<button class="node-detail__open">Open note</button>' : ''}
      ${isNote && opts.onLaunchWakey ? '<button class="node-detail__wakey">☀️ Launch with Wakey</button>' : ''}
      ${isNote && opts.onLaunchSleepy ? '<button class="node-detail__sleepy">🌙 Plan with Sleepy</button>' : ''}
    </footer>`;

  // Assign user-supplied text via textContent — never innerHTML — to prevent XSS.
  el.querySelector('.node-detail__title')!.textContent = node.label;

  const metaEl = el.querySelector<HTMLElement>('.node-detail__meta')!;
  const meta = opts.meta ?? [];
  if (meta.length === 0) {
    metaEl.remove();
  } else {
    for (const row of meta) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      metaEl.append(dt, dd);
    }
  }

  const previewEl = el.querySelector<HTMLElement>('.node-detail__preview')!;
  if (opts.preview) {
    previewEl.textContent = opts.preview.slice(0, 800);
  } else {
    previewEl.remove();
  }

  el.querySelector('.node-detail__close')!.addEventListener('click', () => opts.onClose());
  el.querySelector('.node-detail__goto')?.addEventListener('click', () => opts.onGoToSession!(node.id));
  el.querySelector('.node-detail__launch')?.addEventListener('click', () => opts.onLaunch(node.id));
  el.querySelector('.node-detail__open')?.addEventListener('click', () => opts.onOpenNote(node.id));
  el.querySelector('.node-detail__wakey')?.addEventListener('click', () => opts.onLaunchWakey!(node.id));
  el.querySelector('.node-detail__sleepy')?.addEventListener('click', () => opts.onLaunchSleepy!(node.id));

  return el;
}
