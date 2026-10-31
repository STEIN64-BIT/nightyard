import { createGraphRenderer } from '../graph-renderer/index.js';
import { create2dBackend } from '../graph-renderer/renderer-2d.js';
import { create3dBackend } from '../graph-renderer/renderer-3d.js';
import { getGraph, onChange } from '../agent-graph-store.js';
import { mergeGraphs, type SessionNoteLink } from '../knowledge-graph-store.js';
import { renderNodeDetail } from './node-detail-panel.js';
import { appState } from '../state.js';
import { toggleWakey } from '../state/wakey-state.js';
import type { ProjectRecord, VaultGraph } from '../../shared/types.js';
import type { UnifiedNode } from '../graph-renderer/index.js';

/** Enumerate all sessions across all projects and map those with sourceNoteId
 *  to SessionNoteLink objects for the knowledge-graph merge. Pure helper. */
export function buildSessionNoteLinks(): SessionNoteLink[] {
  return appState.projects.flatMap((p) =>
    p.sessions
      .filter((s) => s.sourceNoteId != null)
      .map((s) => ({ sessionId: s.id, noteId: s.sourceNoteId! })),
  );
}


export interface NodeDetailExtras {
  meta: Array<{ label: string; value: string }>;
  /** Preview text for kinds that have no note body (tags list their notes). */
  preview: string;
  /** Set for session nodes that still exist: where "Go to session" should jump. */
  gotoSession?: { projectId: string; sessionId: string };
}

/** Pure: derive detail-panel metadata for any node kind from app + vault state. */
export function buildNodeDetailExtras(
  node: UnifiedNode,
  projects: ReadonlyArray<ProjectRecord>,
  vault: VaultGraph,
): NodeDetailExtras {
  const meta: Array<{ label: string; value: string }> = [];

  if (node.kind === 'session') {
    for (const p of projects) {
      const s = p.sessions.find((x) => x.id === node.id);
      if (!s) continue;
      meta.push({ label: 'Project', value: p.name });
      if (s.providerId) meta.push({ label: 'Provider', value: s.providerId });
      meta.push({ label: 'Status', value: node.status ?? 'idle' });
      const created = new Date(s.createdAt);
      if (!Number.isNaN(created.getTime())) {
        meta.push({ label: 'Created', value: created.toLocaleString() });
      }
      return { meta, preview: '', gotoSession: { projectId: p.id, sessionId: s.id } };
    }
    meta.push({ label: 'Status', value: node.status ?? 'idle' });
    meta.push({ label: 'Note', value: 'Session no longer open' });
    return { meta, preview: '' };
  }

  if (node.kind === 'project') {
    const p = projects.find((x) => x.id === node.id);
    if (p) {
      meta.push({ label: 'Path', value: p.path });
      meta.push({ label: 'Sessions', value: String(p.sessions.length) });
    }
    return { meta, preview: '' };
  }

  if (node.kind === 'tag') {
    const tag = node.label.replace(/^#/, '');
    const tagged = vault.notes.filter((n) => n.tags.includes(tag));
    meta.push({ label: 'Notes', value: String(tagged.length) });
    const preview = tagged.slice(0, 30).map((n) => `• ${n.title}`).join('\n');
    return { meta, preview };
  }

  if (node.kind === 'note') {
    const n = vault.notes.find((x) => x.id === node.id);
    if (n) {
      if (n.folder) meta.push({ label: 'Folder', value: n.folder });
      if (n.tags.length) meta.push({ label: 'Tags', value: n.tags.map((t) => `#${t}`).join(' ') });
      meta.push({ label: 'Links', value: String(node.degree ?? 0) });
    }
    return { meta, preview: '' };
  }

  // subagent / tool
  if (node.status) meta.push({ label: 'Status', value: node.status });
  return { meta, preview: '' };
}

export function openGraphFullscreen(): void {
  const overlay = document.createElement('div');
  overlay.className = 'vy-graph-overlay';
  overlay.tabIndex = 0;

  const controls = document.createElement('div');
  controls.className = 'vy-graph-controls';

  const close = document.createElement('button');
  close.textContent = 'Close';

  const toggle = document.createElement('button');
  toggle.textContent = '3D';

  const depth = document.createElement('input');
  depth.type = 'range'; depth.min = '0'; depth.max = '3'; depth.value = '2';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'vy-graph-search';
  search.placeholder = 'Search notes & sessions…';

  controls.append(depth, toggle, search, close);

  const surface = document.createElement('div');
  surface.className = 'vy-graph-surface';
  overlay.append(controls, surface);
  document.body.appendChild(overlay);
  overlay.focus();

  // ── vault state ─────────────────────────────────────────────────────────────
  let vaultGraph: VaultGraph = { notes: [], links: [] };
  let currentNodes: UnifiedNode[] = [];

  function mergedUpdate() {
    const { nodes, links } = mergeGraphs(vaultGraph, getGraph(), buildSessionNoteLinks());
    currentNodes = nodes;
    renderer.update(nodes, links);
  }

  // ── renderer ─────────────────────────────────────────────────────────────────
  let mode: '2d' | '3d' = '2d';
  let renderer = createGraphRenderer({ backendFactory: create2dBackend });
  renderer.mount(surface);
  renderer.setDepth(Number(depth.value));

  // Attach node-click listener
  wireNodeClick();

  // Initial data load
  void (async () => {
    vaultGraph = await window.nightyard.vault.getGraph();
    mergedUpdate();
    if (vaultGraph.notes.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'vy-graph-hint';
      hint.textContent = appState.preferences.vaultPath
        ? 'No Markdown notes found in your knowledge vault folder'
        : 'No notes in ~/ObsidianVault — point Preferences → Knowledge vault path at your vault';
      hint.style.cssText = 'opacity:0.7; font-size:11px; align-self:center;';
      controls.prepend(hint);
    }
  })();

  // ── search (250 ms trailing debounce) ────────────────────────────────────────
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      renderer.setSearch(search.value);
    }, 250);
  });

  // ── rebuild on mode toggle ───────────────────────────────────────────────────
  function rebuild() {
    closePanel();
    renderer.destroy();
    surface.innerHTML = '';
    const factory = mode === '3d'
      ? (() => create3dBackend() ?? create2dBackend())
      : create2dBackend;
    renderer = createGraphRenderer({ backendFactory: factory });
    renderer.mount(surface);
    renderer.setDepth(Number(depth.value));
    renderer.setSearch(search.value);
    mergedUpdate();
    wireNodeClick();
  }

  toggle.addEventListener('click', () => {
    mode = mode === '2d' ? '3d' : '2d';
    toggle.textContent = mode === '2d' ? '3D' : '2D';
    rebuild();
  });
  depth.addEventListener('input', () => renderer.setDepth(Number(depth.value)));

  // ── RAF-coalesced subscriptions (agent + vault) ──────────────────────────────
  let raf = 0;
  function scheduleUpdate() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; mergedUpdate(); });
  }

  const unsubAgent = onChange(scheduleUpdate);
  const unsubVault = window.nightyard.vault.onChanged((graph: VaultGraph) => {
    vaultGraph = graph;
    scheduleUpdate();
  });

  // ── node-click → detail panel ────────────────────────────────────────────────
  let openPanel: HTMLElement | null = null;
  let clickSeq = 0;
  function closePanel() { openPanel?.remove(); openPanel = null; }

  function wireNodeClick() {
    renderer.on('nodeClick', async (id: string) => {
      const seq = ++clickSeq;
      const node = currentNodes.find((n) => n.id === id);
      if (!node) return;

      const extras = buildNodeDetailExtras(node, appState.projects, vaultGraph);
      let preview = extras.preview;
      if (node.kind === 'note') {
        try {
          preview = await window.nightyard.vault.readNote(id);
        } catch {
          preview = '';
        }
      }

      if (seq !== clickSeq || !overlay.isConnected) return;
      renderer.setSelected(id);

      const panel = renderNodeDetail(node, {
        preview,
        meta: extras.meta,
        onGoToSession: extras.gotoSession
          ? () => {
              const { projectId, sessionId } = extras.gotoSession!;
              appState.setActiveProject(projectId);
              appState.setActiveSession(projectId, sessionId);
              teardown();
            }
          : undefined,
        onClose() {
          closePanel();
          renderer.setSelected(null);
        },
        onLaunch(noteId: string) {
          const activeProject = appState.activeProject;
          if (!activeProject) {
            alert('Open a project first to launch an agent from a note.');
            return;
          }
          const noteContent = preview || `(note could not be read — open it from the vault at ${noteId})`;
          appState.addNoteSession(activeProject.id, noteId, node.label, noteContent);
          teardown();
        },
        onOpenNote(noteId: string) {
          void window.nightyard.clipboard.write(noteId);
          // Visual feedback: swap button text briefly to confirm the copy.
          const btn = openPanel?.querySelector<HTMLElement>('.node-detail__open');
          if (btn) {
            const original = btn.textContent;
            btn.textContent = 'Copied ✓';
            setTimeout(() => { if (btn.isConnected) btn.textContent = original; }, 1500);
          }
        },
        onLaunchWakey(noteId: string) {
          const activeProject = appState.activeProject;
          if (!activeProject) {
            alert('Open a project first to launch an agent from a note.');
            return;
          }
          const noteContent = preview || `(note could not be read — open it from the vault at ${noteId})`;
          const session = appState.addNoteSession(activeProject.id, noteId, node.label, noteContent);
          if (session) {
            toggleWakey(session.id, `Work on the note "${node.label}" — see the initial prompt.`);
          }
          teardown();
        },
        onLaunchSleepy(noteId: string) {
          const activeProject = appState.activeProject;
          if (!activeProject) {
            alert('Open a project first to launch an agent from a note.');
            return;
          }
          appState.openSleepyTab(activeProject.id, {
            autoStart: true,
            goalText: `Work on note: ${noteId}`,
          });
          teardown();
        },
      });

      // Overlay the panel on top of the graph — append, never replace.
      closePanel();
      openPanel = panel;
      surface.appendChild(panel);
    });
  }

  // ── teardown ─────────────────────────────────────────────────────────────────
  function teardown() {
    closePanel();
    unsubAgent();
    unsubVault();
    if (searchTimer) clearTimeout(searchTimer);
    if (raf) cancelAnimationFrame(raf);
    renderer.destroy();
    overlay.remove();
  }

  close.addEventListener('click', teardown);
  overlay.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    // Scoped Escape: close panel first, then clear search, then tear down overlay.
    if (openPanel) {
      closePanel();
      renderer.setSelected(null);
    } else if (document.activeElement === search && search.value) {
      search.value = '';
      renderer.setSearch('');
    } else {
      teardown();
    }
  });
}
