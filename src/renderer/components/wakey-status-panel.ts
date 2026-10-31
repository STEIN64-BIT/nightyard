import { getRuns, dismissRun, restartRun, stopWakey, setProjectDefaultDirection, onWakeyChange } from '../state/wakey-state.js';
import { appState } from '../state.js';
import { isPrimaryWindow } from '../window-context.js';
import { mySessionIds, onWindowsChanged } from '../window-registry-client.js';
import { eyesSpan, runPhaseToEyes, startEyesTicker, type EyesPhase } from './wakey-eyes.js';
import type { WakeyRun, WakeyStopReason } from '../../shared/types.js';

const REASON_LABELS: Record<WakeyStopReason, string> = {
  'goal-complete': 'goal complete',
  'max-iterations': 'max iterations',
  errors: 'errors',
  user: 'stopped by user',
  'rate-cap': 'rate cap',
};

const BUTTON_STYLE = 'background:transparent; color:#fbbf24; border:1px solid #fbbf24; border-radius:3px; padding:2px 8px; font:inherit; cursor:pointer;';

/**
 * A floating status panel that renders directly from the main-process
 * snapshot (`getRuns()`), which includes stopped/orphaned runs alongside
 * active ones. Unlike the v1 panel (which only showed enabled sessions and
 * vanished the instant a run stopped being active), this one never hides a
 * run just because it stopped — stopped/orphaned rows stay put with
 * [restart]/[dismiss] until the user explicitly dismisses them.
 */
export function mountWakeyStatusPanel(): void {
  let collapsed = localStorage.getItem('wakey-panel-collapsed') === '1';
  // Per-run history-toggle state. Lives in this closure (not localStorage) —
  // unlike the collapse-pill it doesn't need to survive a reload, just re-renders.
  const expandedHistory = new Set<string>();

  const panel = document.createElement('div');
  panel.id = 'wakey-status-panel';
  Object.assign(panel.style, {
    position: 'fixed', right: '12px', bottom: '12px',
    width: '420px', maxWidth: 'calc(100vw - 24px)', boxSizing: 'border-box', maxHeight: '40vh',
    background: 'rgba(0, 0, 0, 0.85)', color: '#fbbf24',
    fontFamily: 'ui-monospace, SF Mono, Monaco, monospace',
    fontSize: '11px', padding: '10px', zIndex: '99998',
    overflowY: 'auto', whiteSpace: 'pre-wrap',
    border: '1px solid #fbbf24', borderRadius: '6px',
    pointerEvents: 'auto',
    display: 'none',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(panel);

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }

  /** Resolve display names for a run even if its session (or project) is gone — orphaned rows must still read coherently. */
  function findRunContext(run: WakeyRun): { projectName: string; sessionName: string } {
    const project = appState.projects.find((p) => p.id === run.projectId);
    const session = project?.sessions.find((s) => s.id === run.sessionId);
    const fallbackProjectName = run.projectPath.split('/').filter(Boolean).pop() || '?';
    return {
      projectName: project?.name ?? fallbackProjectName,
      sessionName: session?.name ?? run.sessionId.slice(0, 8),
    };
  }

  /** Primary window: runs owned by the active project. Host (detached) windows:
   *  runs whose session is hosted here — same ownership source tab-bar.ts uses
   *  (`mySessionIds()` from the window-registry client) so a run scopes to a
   *  window exactly the way its tab does. */
  function windowScopedRuns(allRuns: WakeyRun[]): WakeyRun[] {
    if (isPrimaryWindow()) {
      const activeProjectId = appState.activeProject?.id ?? null;
      return allRuns.filter((r) => r.projectId === activeProjectId);
    }
    const mine = new Set(mySessionIds());
    return allRuns.filter((r) => mine.has(r.sessionId));
  }

  function isActiveRow(run: WakeyRun): boolean {
    return !run.stop && run.phase !== 'orphaned';
  }

  function eyesPhaseForRun(run: WakeyRun): EyesPhase {
    return runPhaseToEyes(run.phase, run.consecutiveErrors > 0 && run.phase !== 'stopped');
  }

  function rowHeader(run: WakeyRun, phase: EyesPhase, projectName: string, sessionName: string, controlsHtml: string): string {
    return `<div style="display:flex; align-items:center; gap:8px;">
    <div style="flex:1; font-weight:700; letter-spacing:0.05em;">${eyesSpan(phase)} WAKEY &middot; ${escapeHtml(projectName)} / ${escapeHtml(sessionName)}</div>
    ${controlsHtml}
  </div>`;
  }

  /** The project-default-direction field, shown once per project (first row for that project wins) —
   *  regardless of whether that row is active, stopped, or orphaned, so the field stays reachable
   *  even when a project's only run isn't currently active. */
  function projectFieldHtml(run: WakeyRun, seenProjectIds: Set<string>): string {
    if (!run.projectId || seenProjectIds.has(run.projectId)) return '';
    seenProjectIds.add(run.projectId);
    const projectDefault = appState.projects.find((p) => p.id === run.projectId)?.wakeyDefaultDirection ?? '';
    return `<div style="margin-top:4px;">
    <input type="text" data-project-default-dir="${escapeHtml(run.projectId)}" value="${escapeHtml(projectDefault)}" placeholder="Default direction for this project…" style="width:100%; box-sizing:border-box; background:rgba(251,191,36,0.06); color:#fbbf24; border:1px solid rgba(251,191,36,0.35); border-radius:3px; padding:3px 6px; font:inherit; font-size:10px; outline:none;" />
  </div>`;
  }

  function renderHistoryToggle(run: WakeyRun): string {
    const isOpen = expandedHistory.has(run.runId);
    const caret = isOpen ? '&#9662;' : '&#9656;';
    const toggle = `<button type="button" data-toggle-history="${escapeHtml(run.runId)}" style="background:transparent; color:#fbbf24; border:none; padding:0; font:inherit; opacity:0.7; cursor:pointer; text-decoration:underline;">history ${caret}</button>`;
    if (!isOpen) return `<div style="margin-top:4px;">${toggle}</div>`;
    const entries = run.history.slice(-5);
    const rows = entries.length
      ? entries.map((h) => `<div style="opacity:0.75; margin-top:2px;">&middot; [${h.kind}] ${escapeHtml(h.text.slice(0, 200))}</div>`).join('')
      : `<div style="opacity:0.5; margin-top:2px;">(no history yet)</div>`;
    return `<div style="margin-top:4px;">${toggle}${rows}</div>`;
  }

  function renderRestartDismiss(run: WakeyRun): string {
    return `<button type="button" data-restart-run="${escapeHtml(run.runId)}" style="${BUTTON_STYLE}">restart</button>
    <button type="button" data-dismiss-run="${escapeHtml(run.runId)}" style="${BUTTON_STYLE} margin-left:4px;">dismiss</button>`;
  }

  function renderRow(run: WakeyRun, seenProjectIds: Set<string>): string {
    const { projectName, sessionName } = findRunContext(run);
    const phase = eyesPhaseForRun(run);
    const fieldHtml = projectFieldHtml(run, seenProjectIds);

    if (run.stop) {
      const reasonLabel = REASON_LABELS[run.stop.reason] ?? run.stop.reason;
      const lastError = run.stop.reason === 'errors'
        ? [...run.history].reverse().find((h) => h.kind === 'error')
        : undefined;
      return `<div style="margin-bottom:8px;">
  ${rowHeader(run, phase, projectName, sessionName, renderRestartDismiss(run))}
  <div style="opacity:0.85;">stopped &middot; ${escapeHtml(reasonLabel)} &middot; ${run.iterations} iters</div>
  ${lastError ? `<div style="opacity:0.7; margin-top:2px;">last error: ${escapeHtml(lastError.text.slice(0, 200))}</div>` : ''}
  ${fieldHtml}
</div>`;
    }

    if (run.phase === 'orphaned') {
      return `<div style="margin-bottom:8px;">
  ${rowHeader(run, phase, projectName, sessionName, renderRestartDismiss(run))}
  <div style="opacity:0.85;">session not restored</div>
  ${fieldHtml}
</div>`;
    }

    // Active row: idle/thinking/typing.
    const phaseLabel = run.phase === 'thinking' ? 'thinking…' : run.phase === 'typing' ? 'typing into session' : 'idle (waiting for next turn)';
    const direction = run.direction?.trim();
    const prompt = run.lastSteer ?? '';
    const stopButton = `<button type="button" data-stop-sid="${escapeHtml(run.sessionId)}" title="Stop Wakey for this session" style="${BUTTON_STYLE}">stop</button>`;
    return `<div style="margin-bottom:8px;">
  ${rowHeader(run, phase, projectName, sessionName, stopButton)}
  <div style="opacity:0.85;">iteration ${run.iterations} &middot; ${phaseLabel}</div>
  ${direction ? `<div style="opacity:0.85; margin-top:2px;">direction: ${escapeHtml(direction)}</div>` : ''}
  ${fieldHtml}
  ${prompt ? `<div style="margin-top:6px; padding:6px; background:rgba(251,191,36,0.08); border-left:2px solid #fbbf24;">
    <div style="opacity:0.7; font-size:10px; margin-bottom:2px;">last prompt to worker:</div>
    <div style="white-space:pre-wrap; word-break:break-word;">${escapeHtml(prompt.slice(0, 600))}${prompt.length > 600 ? '…' : ''}</div>
  </div>` : ''}
  ${renderHistoryToggle(run)}
</div>`;
  }

  function render(): void {
    // Bug 1 fix: preserve project-direction input draft across re-renders.
    // If the focused element is a project-default-dir input inside this panel,
    // capture its current value and selection so we can restore them after
    // rebuilding innerHTML (which would otherwise destroy the draft + focus).
    const activeEl = document.activeElement as HTMLInputElement | null;
    const activeInput = activeEl?.closest?.('#wakey-status-panel [data-project-default-dir]') as HTMLInputElement | null;
    const savedDraft = activeInput
      ? {
          projectId: activeInput.getAttribute('data-project-default-dir') ?? '',
          value: activeInput.value,
          selectionStart: activeInput.selectionStart,
          selectionEnd: activeInput.selectionEnd,
        }
      : null;

    // getRuns() returns the live snapshot array — copy before any
    // filter/sort so we never mutate main's pushed state in place.
    const allRuns = getRuns().slice();
    const scoped = windowScopedRuns(allRuns);

    if (scoped.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';

    const activeRuns = scoped.filter(isActiveRow);

    if (collapsed) {
      const dominantPhase: EyesPhase = activeRuns.some((r) => r.phase === 'thinking')
        ? 'thinking'
        : activeRuns.some((r) => r.phase === 'typing')
          ? 'typing'
          : 'idle';
      panel.innerHTML = `<div style="display:flex; align-items:center; gap:8px; cursor:pointer;" data-expand="1">
        <div style="font-weight:700; letter-spacing:0.05em;">${eyesSpan(dominantPhase)} WAKEY · ${activeRuns.length}</div>
        <div style="opacity:0.6; font-size:10px;">click to expand</div>
      </div>`;
      return;
    }

    const seenProjectIds = new Set<string>();
    const blocks = scoped.map((run) => renderRow(run, seenProjectIds)).join('');

    const elsewhere = allRuns.length - scoped.length;
    const footer = elsewhere > 0
      ? `<div style="opacity:0.5; font-size:10px; margin-top:4px;">+${elsewhere} Wakey elsewhere</div>`
      : '';

    const header = `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <div style="flex:1; opacity:0.7; font-size:10px;">WAKEY</div>
      <button type="button" data-minimize="1" title="Minimize" style="background:transparent; color:#fbbf24; border:1px solid #fbbf24; border-radius:3px; padding:0 8px; font:inherit; cursor:pointer; line-height:1.4;">–</button>
    </div>`;

    panel.innerHTML = header + blocks + footer;

    // Bug 1 fix (continued): restore the draft value + focus + caret after rebuild.
    if (savedDraft) {
      const restored = panel.querySelector<HTMLInputElement>(
        `[data-project-default-dir="${CSS.escape(savedDraft.projectId)}"]`,
      );
      if (restored) {
        restored.value = savedDraft.value;
        restored.focus();
        restored.setSelectionRange(savedDraft.selectionStart ?? 0, savedDraft.selectionEnd ?? 0);
      }
    }
  }

  // Event-delegated clicks. innerHTML is rebuilt every render, so a single
  // listener on the panel root survives re-renders without re-binding.
  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;

    const stopSid = target?.closest('[data-stop-sid]')?.getAttribute('data-stop-sid');
    if (stopSid) { stopWakey(stopSid); return; }

    const restartRunId = target?.closest('[data-restart-run]')?.getAttribute('data-restart-run');
    if (restartRunId) { restartRun(restartRunId); return; }

    const dismissRunId = target?.closest('[data-dismiss-run]')?.getAttribute('data-dismiss-run');
    if (dismissRunId) { dismissRun(dismissRunId); return; }

    const toggleHistoryId = target?.closest('[data-toggle-history]')?.getAttribute('data-toggle-history');
    if (toggleHistoryId) {
      if (expandedHistory.has(toggleHistoryId)) expandedHistory.delete(toggleHistoryId);
      else expandedHistory.add(toggleHistoryId);
      render();
      return;
    }

    if (target?.closest('[data-minimize]')) {
      collapsed = true;
      localStorage.setItem('wakey-panel-collapsed', '1');
      render();
      return;
    }
    if (target?.closest('[data-expand]')) {
      collapsed = false;
      localStorage.setItem('wakey-panel-collapsed', '0');
      render();
    }
  });

  // Save project default direction on Enter or blur.
  function saveDefaultDirection(input: HTMLInputElement): void {
    const projectId = input.getAttribute('data-project-default-dir');
    if (!projectId) return;
    setProjectDefaultDirection(projectId, input.value);
  }

  panel.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const input = target?.closest<HTMLInputElement>('[data-project-default-dir]');
    if (!input) return;
    if (e.key === 'Enter') {
      saveDefaultDirection(input);
      input.blur();
    } else if (e.key === 'Escape') {
      // Bug 2 fix: revert to persisted value WITHOUT saving via the blur handler.
      const projectId = input.getAttribute('data-project-default-dir') ?? '';
      input.value = appState.projects.find((p) => p.id === projectId)?.wakeyDefaultDirection ?? '';
      input.dataset.reverting = '1';
      input.blur();
    }
  });

  panel.addEventListener('blur', (e) => {
    const target = e.target as HTMLElement | null;
    const input = target?.closest<HTMLInputElement>('[data-project-default-dir]');
    if (!input) return;
    // Bug 2 fix: skip saving when Escape triggered the blur (reverting flag is set).
    if (input.dataset.reverting) {
      delete input.dataset.reverting;
      return;
    }
    saveDefaultDirection(input);
  }, true /* capture — blur doesn't bubble */);

  onWakeyChange(render);
  appState.on('project-changed', render);
  appState.on('session-changed', render);
  // Host windows scope runs to `mySessionIds()` — re-render when a tab is
  // dragged into/out of this window so the scoping stays correct live.
  onWindowsChanged(render);

  startEyesTicker();
  render();
}
