import { appState } from './state.js';
import { initSidebar, promptNewProject } from './components/sidebar.js';
import { initTabBar } from './components/tab-bar.js';
import { initSplitLayout } from './components/split-layout.js';
import { initKeybindings } from './keybindings.js';
import { handlePtyData, destroyTerminal, updateCostDisplay, updateContextDisplay, applyThemeToAllTerminals } from './components/terminal-pane.js';
import { setIdle, setHookStatus, notifyInterrupt } from './session-activity.js';
import { parseCost, setCostData, onChange as onCostChange } from './session-cost.js';
import { parseTitle, clearSession as clearTitleSession } from './session-title.js';
import { setContextData, onChange as onContextChange } from './session-context.js';
import { initNotificationSound } from './notification-sound.js';
import { initNotificationDesktop } from './notification-desktop.js';
import { init as initSessionUnread } from './session-unread.js';
import { init as initGithubUnread } from './github-unread.js';
import { initProjectTerminal, handleShellPtyData, handleShellPtyExit, isShellSessionId, applyThemeToAllShells } from './components/project-terminal.js';
import { startPolling as startGitPolling } from './git-status.js';
import { initDebugPanel, logDebugEvent } from './components/debug-panel.js';
import { initGitPanel } from './components/git-panel.js';
import { disconnectInspector } from './components/mcp-inspector.js';
import { initUpdateBanner } from './components/update-banner.js';
import { initSessionHistory } from './components/session-history.js';
import { showUsageModal } from './components/usage-modal.js';
import { captureInitialContext } from './session-insights.js';
import { initInsightAlert } from './components/insight-alert.js';
import { initToolDetector } from './tools/missing-tool-detector.js';
import { initToolAlert } from './components/tool-alert.js';
import { initLargeFileDetector } from './tools/large-file-detector.js';
import { initLargeFileAlert } from './components/large-file-alert.js';
import { initSettingsGuard } from './components/settings-guard-ui.js';
import { checkWhatsNew } from './components/whats-new-dialog.js';
import { initShareManager, forwardPtyData, endShare, cleanupAllShares } from './sharing/share-manager.js';
import { isSharing } from './sharing/peer-host.js';
import { checkStarPrompt } from './components/star-prompt-dialog.js';
import { addEvents as addInspectorEvents } from './session-inspector-state.js';
import type { InspectorEvent, ProjectRecord, SessionRecord } from '../shared/types.js';
import { getContext } from './session-context.js';
import { initSessionInspector } from './components/session-inspector.js';
import { initFilePrompt } from './components/file-prompt.js';
import { applyThemeToAllRemoteTerminals } from './components/remote-terminal-pane.js';
import { loadProviderMetas } from './provider-availability.js';
import { initBoard } from './components/board/board-view.js';
import { initBoardSessionSync } from './board-session-sync.js';
import { initTeamView } from './components/team/team-view.js';
import { getZoomFactor } from './zoom.js';
import { confirmAppClose } from './session-close.js';
import { initWakeyMirror, toggleWakey, isWakeyOn, onWakeyChange } from './state/wakey-state.js';
import { mountWakeyStatusPanel } from './components/wakey-status-panel.js';
import { feedInspectorEvents } from './agent-graph-feed.js';
import { applyEvent as applyGraphEvent, sweep as sweepGraph } from './agent-graph-store.js';
import { openGlobalOverview } from './components/global-overview-view.js';
import { wirePtyAndSessionEvents } from './pty-wiring.js';
import { isPrimaryWindow } from './window-context.js';
import { initWindowRegistryClient } from './window-registry-client.js';
import { initWindowSync } from './state/window-sync.js';

let isQuitting = false;
window.nightyard.app.onQuitting(() => {
  isQuitting = true;
  cleanupAllShares();
});

window.nightyard.app.onConfirmClose(() => {
  confirmAppClose(() => window.nightyard.app.closeConfirmed());
});

async function main(): Promise<void> {
  if (!isPrimaryWindow()) {
    // Session-host window: tab strip + panes only. The Wakey supervision loop
    // lives in the main process now (src/main/wakey/wakey-core.ts) — every
    // window, primary or host, is just a mirror onto it, so this window still
    // needs its own initWakeyMirror()/status panel. Other singleton
    // background services (sharing, git polling, detectors, ...) stay primary.
    document.body.classList.add('window-host');
    wirePtyAndSessionEvents();
    await loadProviderMetas();
    initSessionUnread();
    initTabBar();
    initSplitLayout();
    initKeybindings();
    initNotificationSound();
    initNotificationDesktop();
    initFilePrompt();
    initBoard();
    initTeamView();
    await initWindowRegistryClient();
    initWindowSync();
    await appState.load();
    const hostTheme = appState.preferences.theme ?? 'dark';
    document.documentElement.dataset.theme = hostTheme;
    appState.on('preferences-changed', () => {
      const theme = appState.preferences.theme ?? 'dark';
      document.documentElement.dataset.theme = theme;
      applyThemeToAllTerminals(theme);
    });
    const hostZoom = getZoomFactor();
    if (hostZoom !== 1.0) window.nightyard.zoom.set(hostZoom);
    initWakeyMirror();
    mountWakeyStatusPanel();
    return;
  }

  wirePtyAndSessionEvents();

  // Load provider metadata before components so capabilities are available synchronously
  await loadProviderMetas();

  // Initialize components
  initSessionUnread();
  initGithubUnread();
  initSidebar();
  initTabBar();
  initSplitLayout();
  initKeybindings();
  initNotificationSound();
  initNotificationDesktop();
  initProjectTerminal();
  initDebugPanel();
  initGitPanel();
  initSessionHistory();
  initUpdateBanner();
  initInsightAlert();
  initToolDetector();
  initToolAlert();
  initLargeFileDetector();
  initLargeFileAlert();
  initSettingsGuard();
  initShareManager();
  initSessionInspector();
  initBoard();
  initBoardSessionSync();
  initTeamView();
  initFilePrompt();
  startGitPolling();
  initWakeyMirror();
  mountWakeyStatusPanel();

  document.getElementById('btn-usage-stats')!.addEventListener('click', () => showUsageModal());

  document.getElementById('btn-all-projects')?.addEventListener('click', () => openGlobalOverview());

  // Log AppState events to debug panel
  const stateEvents = [
    'project-added', 'project-removed', 'project-changed',
    'session-added', 'session-removed', 'session-changed',
    'layout-changed', 'history-changed', 'insights-changed', 'state-loaded',
  ] as const;
  for (const evt of stateEvents) {
    appState.on(evt as Parameters<typeof appState.on>[0], (data) => {
      logDebugEvent('stateEvent', evt, data);
    });
  }

  // Multi-window: registry mirror + snapshot sync must precede first render
  await initWindowRegistryClient();
  initWindowSync();

  // Load persisted state
  await appState.load();

  // Seed the agent-graph store with the loaded projects and sessions so the
  // live graph reflects existing state before any new events arrive.
  for (const project of appState.projects) {
    applyGraphEvent({ kind: 'upsert-project', id: project.id, label: project.name });
    for (const session of project.sessions) {
      applyGraphEvent({ kind: 'upsert-session', id: session.id, parentId: project.id, label: session.name ?? session.id, status: 'idle' });
    }
  }

  // Keep the agent-graph store in sync with the project/session lifecycle AFTER
  // load. Without this, projects/sessions created or removed at runtime would
  // never appear (new) or would leave stale nodes (removed) that distort
  // getProjectStatus. AppState emits granular lifecycle events with payloads, so
  // we forward each one directly rather than reconciling a coarse signal.
  appState.on('project-added', (data) => {
    const project = data as ProjectRecord;
    applyGraphEvent({ kind: 'upsert-project', id: project.id, label: project.name });
    for (const session of project.sessions) {
      applyGraphEvent({ kind: 'upsert-session', id: session.id, parentId: project.id, label: session.name ?? session.id, status: 'idle' });
    }
  });
  appState.on('project-removed', (data) => {
    applyGraphEvent({ kind: 'remove-project', id: data as string });
  });
  appState.on('session-added', (data) => {
    const { projectId, session } = data as { projectId: string; session: SessionRecord };
    applyGraphEvent({ kind: 'upsert-session', id: session.id, parentId: projectId, label: session.name ?? session.id, status: 'idle' });
  });
  appState.on('session-removed', (data) => {
    const { sessionId } = data as { projectId: string; sessionId: string };
    applyGraphEvent({ kind: 'remove-session', id: sessionId });
  });
  appState.on('session-renamed', (data) => {
    const { sessionId, name } = data as { projectId: string; sessionId: string; name: string };
    applyGraphEvent({ kind: 'session-label', id: sessionId, label: name });
  });

  // Periodically mark stale 'working' nodes idle (5-min threshold inside sweep).
  // App-lifetime interval; the renderer lives for the app's lifetime so no
  // teardown is needed.
  setInterval(() => sweepGraph(), 60_000);

  // Apply vault path preference from persisted preferences (before graph-fullscreen loads)
  if (appState.preferences.vaultPath) {
    window.nightyard.vault.setPath(appState.preferences.vaultPath);
  }

  // Apply theme from loaded preferences
  const initialTheme = appState.preferences.theme ?? 'dark';
  document.documentElement.dataset.theme = initialTheme;

  // Re-apply theme (and re-theme terminals) whenever preferences change
  appState.on('preferences-changed', () => {
    const theme = appState.preferences.theme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    applyThemeToAllTerminals(theme);
    applyThemeToAllShells(theme);
    applyThemeToAllRemoteTerminals(theme);
  });

  // Light/Dark theme toggle button (sidebar header)
  const themeToggleBtn = document.getElementById('btn-theme-toggle') as HTMLButtonElement | null;
  function syncThemeToggleIcon(): void {
    if (!themeToggleBtn) return;
    const theme = appState.preferences.theme ?? 'dark';
    // Moon glyph for dark mode (click to go to light); sun for light mode (click to go to dark)
    themeToggleBtn.innerHTML = theme === 'dark' ? '&#x263D;' : '&#x2600;';
  }
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = appState.preferences.theme ?? 'dark';
      appState.setPreference('theme', current === 'dark' ? 'light' : 'dark');
    });
    syncThemeToggleIcon();
    appState.on('preferences-changed', syncThemeToggleIcon);
  }

  // SLEEPY header button
  const sleepyToggleBtn = document.getElementById('btn-sleepy-toggle') as HTMLButtonElement | null;
  if (sleepyToggleBtn) {
    sleepyToggleBtn.addEventListener('click', () => {
      const projectId = appState.activeProjectId;
      if (!projectId) return;
      appState.openSleepyTab(projectId, { autoStart: true });
    });
  }

  // Wakey header button
  const wakeyToggleBtn = document.getElementById('btn-wakey-toggle') as HTMLButtonElement | null;
  function syncWakeyBtn(): void {
    if (!wakeyToggleBtn) return;
    const sessionId = appState.activeProject?.activeSessionId;
    const on = sessionId ? isWakeyOn(sessionId) : false;
    wakeyToggleBtn.classList.toggle('wakey-on', on);
    wakeyToggleBtn.title = on ? 'Wakey ON — click to stop' : 'Toggle Wakey for active session';
  }
  if (wakeyToggleBtn) {
    // Inline direction field, created once and positioned under the toggle.
    let directionField: HTMLDivElement | null = null;

    function closeDirectionField(): void {
      directionField?.remove();
      directionField = null;
    }

    function startWakey(sessionId: string, direction: string): void {
      closeDirectionField();
      toggleWakey(sessionId, direction.trim());
    }

    function openDirectionField(sessionId: string): void {
      closeDirectionField();
      const wrap = document.createElement('div');
      wrap.id = 'wakey-direction-field';
      Object.assign(wrap.style, {
        position: 'fixed', zIndex: '100000',
        background: 'rgba(0,0,0,0.9)', color: '#fbbf24',
        border: '1px solid #fbbf24', borderRadius: '6px', padding: '8px',
        font: '12px ui-monospace, SF Mono, Monaco, monospace',
        display: 'flex', flexDirection: 'column', gap: '6px', width: '320px',
      } as Partial<CSSStyleDeclaration>);
      const rect = wakeyToggleBtn!.getBoundingClientRect();
      wrap.style.top = `${rect.bottom + 6}px`;
      wrap.style.left = `${Math.max(8, rect.right - 320)}px`;

      const label = document.createElement('div');
      label.textContent = '(-.-) Wakey direction (optional) — Enter to start, Esc to cancel';
      label.style.opacity = '0.8';

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'e.g. focus on fixing the failing tests';
      Object.assign(input.style, {
        background: 'rgba(251,191,36,0.08)', color: '#fbbf24',
        border: '1px solid #fbbf24', borderRadius: '4px', padding: '6px',
        font: 'inherit', outline: 'none',
      } as Partial<CSSStyleDeclaration>);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          startWakey(sessionId, input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeDirectionField();
        }
      });
      // Clicking outside the field cancels.
      wrap.addEventListener('click', (e) => e.stopPropagation());

      wrap.append(label, input);
      document.body.appendChild(wrap);
      directionField = wrap;
      input.focus();
    }

    // Close the field on any outside click.
    document.addEventListener('click', () => closeDirectionField());

    wakeyToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const project = appState.activeProject;
      const sessionId = project?.activeSessionId;
      const session = sessionId ? project?.sessions.find((s) => s.id === sessionId) : undefined;
      console.log('[wakey] button click', { projectId: project?.id, sessionId, sessionType: session?.type, sessionProvider: session?.providerId });
      if (!project) {
        alert('Wakey: no active project. Open a project first.');
        return;
      }
      if (!sessionId || !session) {
        alert('Wakey: no active session. Open a Claude session in the active project first.');
        return;
      }
      if (session.type) {
        alert(`Wakey: active tab is a "${session.type}" pane, not a CLI session. Switch to a Claude/Codex/etc. session tab.`);
        return;
      }
      // ON → stop immediately. OFF → open the inline direction field; clicking
      // the toggle again while the field is open starts Wakey in default mode.
      if (isWakeyOn(sessionId)) {
        toggleWakey(sessionId);
      } else if (directionField) {
        startWakey(sessionId, '');
      } else {
        openDirectionField(sessionId);
      }
    });
    syncWakeyBtn();
    appState.on('project-changed', syncWakeyBtn);
    appState.on('session-changed', syncWakeyBtn);
    onWakeyChange(syncWakeyBtn);
    appState.on('project-changed', closeDirectionField);
    appState.on('session-changed', closeDirectionField);
  }

  const savedZoom = getZoomFactor();
  if (savedZoom !== 1.0) window.nightyard.zoom.set(savedZoom);

  // Auto-open new project modal when no projects exist
  if (appState.projects.length === 0) {
    promptNewProject();
  }

  checkWhatsNew();
  checkStarPrompt();
}

main().catch(console.error);
