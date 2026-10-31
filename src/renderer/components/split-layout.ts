import { appState, ProjectRecord } from '../state.js';
import type { SessionRecord } from '../state.js';
import { isUnread, onChange as onUnreadChange } from '../session-unread.js';
import { isPrimaryWindow } from '../window-context.js';
import { isSessionHostedHere, myActiveSessionId, onWindowsChanged } from '../window-registry-client.js';
import { visibleSessions } from './tab-bar.js';
import {
  createTerminalPane,
  attachToContainer,
  showPane,
  hideAllPanes,
  fitAllVisible,
  setFocused,
  spawnTerminal,
  setPendingPrompt,
  setPendingSystemPrompt,
  destroyTerminal,
  disposeTerminalView,
  getTerminalInstance,
} from './terminal-pane.js';
import {
  createInspectorPane,
  destroyInspectorPane,
  showInspectorPane,
  hideAllInspectorPanes,
  attachInspectorToContainer,
  getInspectorInstance,
  disconnectInspector,
} from './mcp-inspector.js';
import { isInspectorOpen } from './session-inspector.js';
import {
  createFileViewerPane,
  destroyFileViewerPane,
  showFileViewerPane,
  hideAllFileViewerPanes,
  attachFileViewerToContainer,
  getFileViewerInstance,
} from './file-viewer.js';
import {
  createFileReaderPane,
  destroyFileReaderPane,
  showFileReaderPane,
  hideAllFileReaderPanes,
  attachFileReaderToContainer,
  getFileReaderInstance,
  setFileReaderLine,
} from './file-reader.js';
import {
  getRemoteTerminalInstance,
  destroyRemoteTerminal,
  attachRemoteToContainer,
  showRemotePane,
  hideAllRemotePanes,
} from './remote-terminal-pane.js';
import {
  createBrowserTabPane,
  destroyBrowserTabPane,
  showBrowserTabPane,
  hideAllBrowserTabPanes,
  attachBrowserTabToContainer,
  getBrowserTabInstance,
} from './browser-tab-pane.js';
import {
  createProjectTabPane,
  destroyProjectTabPane,
  showProjectTabPane,
  hideAllProjectTabPanes,
  attachProjectTabToContainer,
  getProjectTabInstance,
} from './project-tab/pane.js';
import {
  createKanbanPane,
  destroyKanbanPane,
  showKanbanPane,
  hideAllKanbanPanes,
  attachKanbanToContainer,
  getKanbanInstance,
} from './kanban/pane.js';
import {
  createTeamPane,
  destroyTeamPane,
  showTeamPane,
  hideAllTeamPanes,
  attachTeamToContainer,
  getTeamInstance,
} from './team/pane.js';
import {
  createCounselPane,
  destroyCounselPane,
  showCounselPane,
  hideAllCounselPanes,
  attachCounselToContainer,
  getCounselInstance,
} from './counsel/pane.js';
import {
  createSleepyPane,
  destroySleepyPaneById,
  showSleepyPane,
  hideAllSleepyPanes,
  attachSleepyToContainer,
  getSleepyInstance,
} from './sleepy/pane.js';
import { quickNewSession } from './tab-bar.js';
import { isCliSession } from '../session-utils.js';

const container = document.getElementById('terminal-container')!;

/** Set the container's layout class while preserving the inspector-open class if active. */
function setContainerClass(cls: string): void {
  const hasInspector = isInspectorOpen();
  container.className = cls;
  if (hasInspector) container.classList.add('inspector-open');
}

export function initSplitLayout(): void {
  appState.on('state-loaded', renderLayout);
  appState.on('project-changed', renderLayout);
  appState.on('session-added', onSessionAdded);
  appState.on('session-removed', onSessionRemoved);
  appState.on('session-changed', renderLayout);
  appState.on('layout-changed', renderLayout);

  onWindowsChanged(renderLayout);
  // Transfer protocol: losing a session drops only its view (the pty lives in
  // main); gaining one re-renders so the pane mounts and replays.
  window.nightyard.windows.onSessionReleased((sessionId) => {
    disposeViewForSession(sessionId);
    renderLayout();
  });
  window.nightyard.windows.onSessionAssigned(() => renderLayout());

  onUnreadChange(() => {
    const project = appState.activeProject;
    if (project?.layout.mode === 'swarm') updateSwarmPaneStyles(project);
  });

  // Refit on window resize
  window.addEventListener('resize', () => {
    requestAnimationFrame(fitAllVisible);
  });

  // Click delegation for swarm mode: clicking a dimmed pane makes it active
  container.addEventListener('mousedown', (e) => {
    const project = appState.activeProject;
    if (!project || project.layout.mode !== 'swarm') return;

    const paneEl = (e.target as HTMLElement).closest('.terminal-pane') as HTMLElement | null;
    if (!paneEl) return;

    const sessionId = paneEl.dataset.sessionId;
    if (sessionId && sessionId !== project.activeSessionId) {
      appState.setActiveSession(project.id, sessionId);
    }
  });
}

function onSessionAdded(data: unknown): void {
  const { projectId, session } = data as { projectId: string; session: { id: string; type?: string; cliSessionId: string | null; providerId?: string; args?: string; account?: string; cwd?: string; diffFilePath?: string; diffArea?: string; worktreePath?: string; fileReaderPath?: string; fileReaderLine?: number; browserTabUrl?: string } };
  const project = appState.projects.find((p) => p.id === projectId) ?? appState.activeProject;
  if (!project) return;

  if (session.type === 'file-reader') {
    createFileReaderPane(session.id, session.fileReaderPath || '', session.fileReaderLine);
    renderLayout();
  } else if (session.type === 'diff-viewer') {
    createFileViewerPane(session.id, session.diffFilePath || '', session.diffArea || '', session.worktreePath);
    renderLayout();
  } else if (session.type === 'mcp-inspector') {
    createInspectorPane(session.id);
    renderLayout();
  } else if (session.type === 'remote-terminal') {
    // Remote terminal pane is created by share-manager before session-added fires
    renderLayout();
  } else if (session.type === 'browser-tab') {
    createBrowserTabPane(session.id, session.browserTabUrl);
    renderLayout();
  } else if (session.type === 'project-tab') {
    createProjectTabPane(session.id, projectId);
    renderLayout();
  } else if (session.type === 'kanban') {
    createKanbanPane(session.id, projectId);
    renderLayout();
  } else if (session.type === 'team') {
    createTeamPane(session.id, projectId);
    renderLayout();
  } else if (session.type === 'counsel') {
    createCounselPane(session.id, projectId);
    renderLayout();
  } else if (session.type === 'sleepy') {
    createSleepyPane(session.id, projectId);
    renderLayout();
  } else {
    // Create and spawn immediately
    createTerminalPane(session.id, project.path, session.cliSessionId, !!session.cliSessionId, session.args || '', (session.providerId as import('../../shared/types').ProviderId) || 'claude', project.id, session.account);
    const pending = appState.consumePendingInitialPrompt(project.id, session.id);
    if (pending) {
      setPendingPrompt(session.id, pending);
    }
    const pendingSys = appState.consumePendingSystemPrompt(project.id, session.id);
    if (pendingSys) {
      setPendingSystemPrompt(session.id, pendingSys);
    }
    renderLayout();

    // Spawn after layout is rendered so terminal has dimensions
    requestAnimationFrame(() => {
      spawnTerminal(session.id);
      fitAllVisible();
    });
  }
}

/** Drop a session's view in this window without closing the session (it moved windows). */
function disposeViewForSession(sessionId: string): void {
  if (getFileReaderInstance(sessionId)) destroyFileReaderPane(sessionId);
  else if (getFileViewerInstance(sessionId)) destroyFileViewerPane(sessionId);
  else if (getInspectorInstance(sessionId)) { disconnectInspector(sessionId); destroyInspectorPane(sessionId); }
  else if (getBrowserTabInstance(sessionId)) destroyBrowserTabPane(sessionId);
  else if (getProjectTabInstance(sessionId)) destroyProjectTabPane(sessionId);
  else if (getKanbanInstance(sessionId)) destroyKanbanPane(sessionId);
  else if (getTeamInstance(sessionId)) destroyTeamPane(sessionId);
  else if (getCounselInstance(sessionId)) destroyCounselPane(sessionId);
  else if (getTerminalInstance(sessionId)) disposeTerminalView(sessionId);
}

function onSessionRemoved(data: unknown): void {
  const { sessionId } = data as { projectId: string; sessionId: string };
  if (getFileReaderInstance(sessionId)) {
    destroyFileReaderPane(sessionId);
  } else if (getFileViewerInstance(sessionId)) {
    destroyFileViewerPane(sessionId);
  } else if (getInspectorInstance(sessionId)) {
    disconnectInspector(sessionId);
    destroyInspectorPane(sessionId);
  } else if (getRemoteTerminalInstance(sessionId)) {
    destroyRemoteTerminal(sessionId);
  } else if (getBrowserTabInstance(sessionId)) {
    destroyBrowserTabPane(sessionId);
  } else if (getProjectTabInstance(sessionId)) {
    destroyProjectTabPane(sessionId);
  } else if (getKanbanInstance(sessionId)) {
    destroyKanbanPane(sessionId);
  } else if (getTeamInstance(sessionId)) {
    destroyTeamPane(sessionId);
  } else if (getCounselInstance(sessionId)) {
    destroyCounselPane(sessionId);
  } else if (getSleepyInstance(sessionId)) {
    destroySleepyPaneById(sessionId);
  } else {
    destroyTerminal(sessionId);
  }
  renderLayout();
}

export function renderLayout(): void {
  const project = appState.activeProject;
  const sessions = visibleSessions(project);

  if ((isPrimaryWindow() && !project) || sessions.length === 0) {
    hideAllPanes();
    hideAllInspectorPanes();
    hideAllFileViewerPanes();
    hideAllFileReaderPanes();
    hideAllRemotePanes();
    hideAllBrowserTabPanes();
    hideAllProjectTabPanes();
    hideAllKanbanPanes();
    hideAllTeamPanes();
    hideAllCounselPanes();
    hideAllSleepyPanes();
    setContainerClass('');
    showEmptyState(project);
    return;
  }

  removeEmptyState();
  container.querySelectorAll('.swarm-grid-wrapper').forEach(el => el.remove());
  container.querySelectorAll('.swarm-empty-cell').forEach(el => el.remove());

  // Ensure all sessions have their respective instances (owner project per
  // session — host windows can mix projects in one strip)
  for (const session of sessions) {
    const owner = appState.findSessionWithProject(session.id)?.project ?? project!;
    if (session.type === 'file-reader') {
      if (!getFileReaderInstance(session.id)) {
        createFileReaderPane(session.id, session.fileReaderPath || '', session.fileReaderLine);
      }
    } else if (session.type === 'diff-viewer') {
      if (!getFileViewerInstance(session.id)) {
        createFileViewerPane(session.id, session.diffFilePath || '', session.diffArea || '', session.worktreePath);
      }
    } else if (session.type === 'mcp-inspector') {
      if (!getInspectorInstance(session.id)) {
        createInspectorPane(session.id);
      }
    } else if (session.type === 'remote-terminal') {
      // Remote terminal instances are created by share-manager, skip here
    } else if (session.type === 'browser-tab') {
      if (!getBrowserTabInstance(session.id)) {
        createBrowserTabPane(session.id, session.browserTabUrl);
      }
    } else if (session.type === 'project-tab') {
      if (!getProjectTabInstance(session.id)) {
        createProjectTabPane(session.id, owner.id);
      }
    } else if (session.type === 'kanban') {
      if (!getKanbanInstance(session.id)) {
        createKanbanPane(session.id, owner.id);
      }
    } else if (session.type === 'team') {
      if (!getTeamInstance(session.id)) {
        createTeamPane(session.id, owner.id);
      }
    } else if (session.type === 'counsel') {
      if (!getCounselInstance(session.id)) {
        createCounselPane(session.id, owner.id);
      }
    } else if (session.type === 'sleepy') {
      if (!getSleepyInstance(session.id)) {
        createSleepyPane(session.id, owner.id);
      }
    } else {
      if (!getTerminalInstance(session.id)) {
        createTerminalPane(session.id, owner.path, session.cliSessionId, !!session.cliSessionId, session.args || '', session.providerId || 'claude', owner.id, session.account);
      }
    }
  }

  hideAllPanes();
  hideAllInspectorPanes();
  hideAllFileViewerPanes();
  hideAllFileReaderPanes();
  hideAllRemotePanes();
  hideAllBrowserTabPanes();
  hideAllProjectTabPanes();
  hideAllKanbanPanes();
  hideAllTeamPanes();
  hideAllCounselPanes();
  hideAllSleepyPanes();

  if (!isPrimaryWindow()) {
    renderTabModeForSessions(sessions);
  } else if (project!.layout.mode === 'swarm' && hostedSplitPanes(project!).length >= 1) {
    renderSwarmMode(project!);
  } else if (project!.layout.mode === 'split' && hostedSplitPanes(project!).length > 1) {
    renderSplitMode(project!);
  } else {
    renderTabMode(project!);
  }

  requestAnimationFrame(fitAllVisible);
}

/** splitPanes minus sessions detached into other windows. */
function hostedSplitPanes(project: ProjectRecord): string[] {
  return project.layout.splitPanes.filter((id) => isSessionHostedHere(id));
}

/** Host windows: plain tab mode over this window's sessions (any project). */
function renderTabModeForSessions(sessions: SessionRecord[]): void {
  setContainerClass('');
  container.style.gridTemplateColumns = '';
  container.style.gridTemplateRows = '';

  const activeId = myActiveSessionId();
  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  if (!activeSession) return;

  if (!isCliSession(activeSession)) {
    attachNonCliPane(activeSession, container, false);
    return;
  }

  attachToContainer(activeSession.id, container);
  showPane(activeSession.id, false);

  if (!document.querySelector('#tab-list .tab-name input')) {
    setFocused(activeSession.id);
  }

  const instance = getTerminalInstance(activeSession.id);
  if (instance && !instance.spawned && !instance.exited) {
    requestAnimationFrame(() => {
      spawnTerminal(activeSession.id);
      fitAllVisible();
    });
  }
}

/** Attach and show a non-CLI session pane. */
function attachNonCliPane(session: { id: string; type?: string; fileReaderLine?: number }, target: HTMLElement, inSplit: boolean): void {
  if (session.type === 'file-reader') {
    attachFileReaderToContainer(session.id, target);
    showFileReaderPane(session.id, inSplit);
    if (session.fileReaderLine) {
      setFileReaderLine(session.id, session.fileReaderLine);
    }
  } else if (session.type === 'diff-viewer') {
    attachFileViewerToContainer(session.id, target);
    showFileViewerPane(session.id, inSplit);
  } else if (session.type === 'mcp-inspector') {
    attachInspectorToContainer(session.id, target);
    showInspectorPane(session.id, inSplit);
  } else if (session.type === 'remote-terminal') {
    attachRemoteToContainer(session.id, target);
    showRemotePane(session.id, inSplit);
  } else if (session.type === 'browser-tab') {
    attachBrowserTabToContainer(session.id, target);
    showBrowserTabPane(session.id, inSplit);
  } else if (session.type === 'project-tab') {
    attachProjectTabToContainer(session.id, target);
    showProjectTabPane(session.id, inSplit);
  } else if (session.type === 'kanban') {
    attachKanbanToContainer(session.id, target);
    showKanbanPane(session.id, inSplit);
  } else if (session.type === 'team') {
    attachTeamToContainer(session.id, target);
    showTeamPane(session.id, inSplit);
  } else if (session.type === 'counsel') {
    attachCounselToContainer(session.id, target);
    showCounselPane(session.id, inSplit);
  } else if (session.type === 'sleepy') {
    attachSleepyToContainer(session.id, target);
    showSleepyPane(session.id, inSplit);
  }
}

function renderTabMode(project: ProjectRecord): void {
  setContainerClass('');
  container.style.gridTemplateColumns = '';
  container.style.gridTemplateRows = '';

  // The project's active session may live in another window — fall back to
  // the first tab this window actually shows (render-only, no state change).
  const activeId = project.activeSessionId && isSessionHostedHere(project.activeSessionId)
    ? project.activeSessionId
    : visibleSessions(project)[0]?.id ?? null;
  if (!activeId) return;

  const activeSession = project.sessions.find(s => s.id === activeId);
  if (activeSession && !isCliSession(activeSession)) {
    attachNonCliPane(activeSession, container, false);
    return;
  }

  attachToContainer(activeId, container);
  showPane(activeId, false);

  // Don't steal focus from an active tab rename input
  if (!document.querySelector('#tab-list .tab-name input')) {
    setFocused(activeId);
  }

  const instance = getTerminalInstance(activeId);
  if (instance && !instance.spawned && !instance.exited) {
    requestAnimationFrame(() => {
      spawnTerminal(activeId);
      fitAllVisible();
    });
  }
}

/** Attach, show, and ensure-spawn for each pane in the list. */
function showPanes(project: ProjectRecord, target: HTMLElement = container): void {
  for (const paneId of hostedSplitPanes(project)) {
    const session = project.sessions.find(s => s.id === paneId);
    if (session && !isCliSession(session)) {
      attachNonCliPane(session, target, true);
      continue;
    }

    attachToContainer(paneId, target);
    showPane(paneId, true);

    const instance = getTerminalInstance(paneId);
    if (instance && !instance.spawned && !instance.exited) {
      requestAnimationFrame(() => spawnTerminal(paneId));
    }
  }
}

function focusActivePane(project: ProjectRecord): void {
  // Don't steal focus from an active tab rename input
  if (document.querySelector('#tab-list .tab-name input')) return;

  if (project.activeSessionId && project.layout.splitPanes.includes(project.activeSessionId)) {
    setFocused(project.activeSessionId);
  } else if (project.layout.splitPanes.length > 0) {
    setFocused(project.layout.splitPanes[0]);
  }
}

function renderSplitMode(project: ProjectRecord): void {
  setContainerClass(`split-${project.layout.splitDirection}`);
  container.style.gridTemplateColumns = '';
  container.style.gridTemplateRows = '';
  showPanes(project);
  focusActivePane(project);
}

function renderSwarmMode(project: ProjectRecord): void {
  const count = hostedSplitPanes(project).length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const activeSession = project.sessions.find(s => s.id === project.activeSessionId && isSessionHostedHere(s.id));
  const nonCliSession = (activeSession && !isCliSession(activeSession))
    ? activeSession
    : [...project.sessions].reverse().find(s => !isCliSession(s) && isSessionHostedHere(s.id));

  const hasInspector = isInspectorOpen();

  setContainerClass('swarm-mode');

  const needsWrapper = nonCliSession || hasInspector;

  if (needsWrapper) {
    const colParts: string[] = ['1fr'];
    if (nonCliSession) colParts.push('1fr');
    if (hasInspector) colParts.push('var(--inspector-width, 350px)');

    container.style.gridTemplateColumns = colParts.join(' ');
    container.style.gridTemplateRows = '1fr';

    const gridWrapper = document.createElement('div');
    gridWrapper.className = 'swarm-grid-wrapper';
    gridWrapper.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    gridWrapper.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    container.appendChild(gridWrapper);

    showPanes(project, gridWrapper);
    appendEmptyCells(cols * rows - count, gridWrapper);

    if (nonCliSession) {
      attachNonCliPane(nonCliSession, container, true);
    }

    if (hasInspector) {
      const inspectorEl = container.querySelector('#session-inspector');
      if (inspectorEl) {
        container.appendChild(inspectorEl);
      }
    }
  } else {
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    showPanes(project);
    appendEmptyCells(cols * rows - count, container);
  }

  updateSwarmPaneStyles(project);
  focusActivePane(project);
}

function appendEmptyCells(count: number, target: HTMLElement): void {
  for (let i = 0; i < count; i++) {
    const cell = document.createElement('div');
    cell.className = 'swarm-empty-cell';

    const btn = document.createElement('button');
    btn.className = 'swarm-empty-add-btn';
    btn.textContent = '+';
    btn.title = 'New session';
    btn.addEventListener('click', () => quickNewSession());

    cell.appendChild(btn);
    target.appendChild(cell);
  }
}

function updateSwarmPaneStyles(project: ProjectRecord): void {
  for (const paneId of project.layout.splitPanes) {
    const instance = getTerminalInstance(paneId);
    if (instance) {
      const isActive = paneId === project.activeSessionId;
      instance.element.classList.toggle('swarm-dimmed', !isActive);
      instance.element.classList.toggle('swarm-unread', !isActive && isUnread(paneId));
    }
  }
}

function showEmptyState(project: ProjectRecord | undefined): void {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = 'empty-state';
  if (!project) {
    el.innerHTML = `
      <div class="sleepy-glyph">(-.-) zZz</div>
      <div>No project selected</div>
      <div class="hint">Create a project with the + button in the sidebar</div>
    `;
  } else {
    el.innerHTML = `
      <div class="sleepy-glyph">(-.-) zZz</div>
      <div>No sessions in "${project.name}"</div>
      <div class="hint">Create a session with the + button in the tab bar</div>
    `;
  }
  container.appendChild(el);
}

function removeEmptyState(): void {
  container.querySelector('.empty-state')?.remove();
}
