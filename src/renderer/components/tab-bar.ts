import { appState, MAX_SESSION_NAME_LENGTH, type ProjectRecord, type SessionRecord } from '../state.js';
import { mergeDefaultArgs } from '../../shared/args-utils.js';
import type { ProviderId } from '../../shared/types.js';
import { showModal, closeModal, setModalError, FieldDef } from './modal.js';
import { onChange as onStatusChange, getStatus, type SessionStatus } from '../session-activity.js';
import { onChange as onGitStatusChange, getGitStatus, getActiveGitPath, refreshGitStatus } from '../git-status.js';

import { isUnread, onChange as onUnreadChange } from '../session-unread.js';
import { hasUnreadInProject as hasGithubUnread, onChange as onGithubUnreadChange } from '../github-unread.js';
import { showHelpDialog } from './help-dialog.js';
import { showShareDialog } from './share-dialog.js';
import { showJoinDialog } from './join-dialog.js';
import { isSharing } from '../sharing/peer-host.js';
import { endShare, onShareChange } from '../sharing/share-manager.js';
import { openInspector, isInspectorOpen, getInspectedSessionId, closeInspector } from './session-inspector.js';
import {
  loadProviderAvailability,
  hasMultipleAvailableProviders,
  getProviderAvailabilitySnapshot,
  getProviderCapabilities,
  getProviderDisplayName,
} from '../provider-availability.js';
import { buildResumeWithProviderItems } from './resume-with-provider-menu.js';
import { codexSessionMenuEntries } from './codex-account-menu.js';
import { isCliSession } from '../session-utils.js';
import {
  closeSessionWithConfirm,
  closeAllSessionsWithConfirm,
  closeOtherSessionsWithConfirm,
  closeSessionsFromRightWithConfirm,
  closeSessionsFromLeftWithConfirm,
} from '../session-close.js';
import { isWakeyOn, onWakeyChange, getIterations, getPhase, hasRunErrors } from '../state/wakey-state.js';
import { eyesSpan, runPhaseToEyes, startEyesTicker } from './wakey-eyes.js';
import { isPrimaryWindow, windowId } from '../window-context.js';
import { isSessionHostedHere, mySessionIds, myActiveSessionId, setMyActiveSession, onWindowsChanged } from '../window-registry-client.js';
import { isDetachable, writeTabDragPayload, hasTabDragPayload, readTabDragPayload, computeDropIndex } from './tab-drag.js';

const tabListEl = document.getElementById('tab-list')!;
const gitStatusEl = document.getElementById('git-status')!;
const btnAddSession = document.getElementById('btn-add-session')!;
const btnAddSessionMenu = document.getElementById('btn-add-session-menu')!;
const btnAddMcpInspector = document.getElementById('btn-add-mcp-inspector')!;
const btnToggleSwarm = document.getElementById('btn-toggle-swarm')!;
const btnAddBrowserTab = document.getElementById('btn-add-browser-tab')!;
const btnHelp = document.getElementById('btn-help')!;

let activeContextMenu: HTMLElement | null = null;
const prevStatus = new Map<string, SessionStatus>();

/** Sessions this window's tab strip shows: primary = active project's non-detached; host = my assigned sessions. */
export function visibleSessions(project: ProjectRecord | undefined): SessionRecord[] {
  if (isPrimaryWindow()) {
    if (!project) return [];
    return project.sessions.filter((s) => isSessionHostedHere(s.id));
  }
  return mySessionIds()
    .map((id) => appState.findSessionWithProject(id)?.session)
    .filter((s): s is SessionRecord => !!s);
}

function buildTooltip(status: SessionStatus, cliSessionId?: string): string {
  const statusLine = `Status: ${status}`;
  return cliSessionId ? `${statusLine}\nSession: ${cliSessionId}` : statusLine;
}

export function initTabBar(): void {
  btnAddSession.addEventListener('click', () => quickNewSession());
  btnAddSession.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showAddSessionContextMenu(e.clientX, e.clientY);
  });
  btnAddSessionMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = btnAddSessionMenu.getBoundingClientRect();
    showAddSessionContextMenu(rect.right, rect.bottom + 2);
  });
  btnAddMcpInspector.addEventListener('click', promptNewMcpInspector);
  btnToggleSwarm.addEventListener('click', () => appState.toggleSwarm());
  btnAddBrowserTab.addEventListener('click', () => {
    const project = appState.activeProject;
    if (project) appState.addBrowserTabSession(project.id);
  });
  btnHelp.addEventListener('click', () => showHelpDialog());
  gitStatusEl.addEventListener('click', (e) => showBranchContextMenu(e));

  // Icons only distinguish providers when multiple are installed
  loadProviderAvailability().then(() => {
    if (hasMultipleAvailableProviders()) render();
  }).catch(() => {});

  appState.on('state-loaded', render);
  appState.on('project-changed', render);
  appState.on('session-added', render);
  appState.on('session-removed', (data?: unknown) => {
    const d = data as { sessionId?: string } | undefined;
    if (d?.sessionId) {
      prevStatus.delete(d.sessionId);
    }
    render();
  });
  appState.on('session-changed', render);
  appState.on('layout-changed', render);
  onShareChange(render);

  onStatusChange((sessionId, status) => {
    const prev = prevStatus.get(sessionId);
    prevStatus.set(sessionId, status);

    const dot = tabListEl.querySelector(`.tab-item[data-session-id="${sessionId}"] .tab-status`) as HTMLElement | null;
    if (dot) {
      dot.className = `tab-status ${status}`;
    }
    const tab = tabListEl.querySelector(`.tab-item[data-session-id="${sessionId}"]`) as HTMLElement | null;
    if (tab) {
      const session = appState.activeProject?.sessions.find(s => s.id === sessionId);
      tab.title = buildTooltip(status, session?.cliSessionId);
    }

  });

  onUnreadChange(render);
  onGithubUnreadChange(render);
  onWakeyChange(render);
  // Idempotent — also started by the status panel; called here too so
  // detached/host windows animate their tab badges even without the panel
  // mounted (or mounted later).
  startEyesTicker();

  onGitStatusChange((projectId) => {
    if (projectId === appState.activeProjectId) renderGitStatus();
  });
  appState.on('project-changed', renderGitStatus);

  document.addEventListener('click', hideTabContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTabContextMenu(); });

  onWindowsChanged(render);

  // Chrome-style release rules for tab drags anywhere in this window:
  // on the strip (but not on a tab) → attach/reorder at position; over the
  // content area → tear off into a new window at the cursor.
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && hasTabDragPayload(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !hasTabDragPayload(e.dataTransfer)) return;
    if (e.defaultPrevented) return; // a tab's own drop handler took it
    e.preventDefault();
    const payload = readTabDragPayload(e.dataTransfer);
    if (!payload) return;
    const strip = document.getElementById('tab-bar')!;
    if (strip.contains(e.target as Node)) {
      // Empty strip area → attach/move to the computed end position.
      const rects = [...tabListEl.querySelectorAll('.tab-item')].map((t) => {
        const r = (t as HTMLElement).getBoundingClientRect();
        return { left: r.left, width: r.width };
      });
      const index = computeDropIndex(rects, e.clientX);
      if (payload.sourceWindowId === windowId && isPrimaryWindow()) {
        const project = appState.activeProject;
        if (project) {
          appState.reorderSession(project.id, payload.sessionId, Math.max(0, Math.min(index, project.sessions.length - 1)));
        }
      } else {
        window.nightyard.windows.transfer(payload.sessionId, windowId, index);
      }
      return;
    }
    // Released over window content → Chrome-style tear-off at the cursor.
    window.nightyard.windows.tearOffAt(payload.sessionId, e.screenX, e.screenY);
  });

  render();
}

function startRename(tab: HTMLElement, project: ProjectRecord, session: SessionRecord): void {
  if (session.type === 'kanban' || session.type === 'project-tab' || session.type === 'team' || session.type === 'counsel') return;
  const nameSpan = tab.querySelector('.tab-name') as HTMLElement;
  if (nameSpan.querySelector('input')) return;

  const input = document.createElement('input');
  input.maxLength = MAX_SESSION_NAME_LENGTH;
  input.value = session.name;
  nameSpan.textContent = '';
  nameSpan.appendChild(input);
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.remove();
    if (newName && newName !== session.name) {
      appState.renameSession(project.id, session.id, newName, true);
    } else {
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      input.remove();
      render();
    }
  });

  input.addEventListener('blur', commit);
}

function showTabContextMenu(x: number, y: number, project: ProjectRecord, session: SessionRecord, tab: HTMLElement): void {
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renamable = session.type !== 'kanban' && session.type !== 'project-tab' && session.type !== 'team' && session.type !== 'counsel';
  const renameItem = document.createElement('div');
  renameItem.className = 'tab-context-menu-item' + (renamable ? '' : ' disabled');
  renameItem.textContent = 'Rename';
  if (renamable) {
    renameItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      startRename(tab, project, session);
    });
  }

  const closeItem = document.createElement('div');
  closeItem.className = 'tab-context-menu-item';
  closeItem.textContent = 'Close';
  closeItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    closeSessionWithConfirm(project.id, session.id);
  });

  const sessionIdx = project.sessions.findIndex((s) => s.id === session.id);
  const totalSessions = project.sessions.length;

  const separator = document.createElement('div');
  separator.className = 'tab-context-menu-separator';

  const closeAllItem = document.createElement('div');
  closeAllItem.className = 'tab-context-menu-item';
  closeAllItem.textContent = 'Close All';
  closeAllItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    closeAllSessionsWithConfirm(project.id);
  });

  const closeOthersItem = document.createElement('div');
  closeOthersItem.className = 'tab-context-menu-item' + (totalSessions <= 1 ? ' disabled' : '');
  closeOthersItem.textContent = 'Close Others';
  if (totalSessions > 1) {
    closeOthersItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      closeOtherSessionsWithConfirm(project.id, session.id);
    });
  }

  const closeRightItem = document.createElement('div');
  closeRightItem.className = 'tab-context-menu-item' + (sessionIdx >= totalSessions - 1 ? ' disabled' : '');
  closeRightItem.textContent = 'Close to the Right';
  if (sessionIdx < totalSessions - 1) {
    closeRightItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      closeSessionsFromRightWithConfirm(project.id, session.id);
    });
  }

  const closeLeftItem = document.createElement('div');
  closeLeftItem.className = 'tab-context-menu-item' + (sessionIdx <= 0 ? ' disabled' : '');
  closeLeftItem.textContent = 'Close to the Left';
  if (sessionIdx > 0) {
    closeLeftItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      closeSessionsFromLeftWithConfirm(project.id, session.id);
    });
  }

  const moveLeftItem = document.createElement('div');
  moveLeftItem.className = 'tab-context-menu-item' + (sessionIdx <= 0 ? ' disabled' : '');
  moveLeftItem.textContent = 'Move Left';
  if (sessionIdx > 0) {
    moveLeftItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      appState.reorderSession(project.id, session.id, sessionIdx - 1);
    });
  }

  const moveRightItem = document.createElement('div');
  moveRightItem.className = 'tab-context-menu-item' + (sessionIdx >= totalSessions - 1 ? ' disabled' : '');
  moveRightItem.textContent = 'Move Right';
  if (sessionIdx < totalSessions - 1) {
    moveRightItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      appState.reorderSession(project.id, session.id, sessionIdx + 1);
    });
  }

  // Share menu items — only for CLI sessions (not special types)
  const isCli = isCliSession(session);
  const isRemote = session.type === 'remote-terminal';
  const providerCapabilities = getProviderCapabilities(session.providerId || 'claude');
  const canInspect = isCli && providerCapabilities?.hookStatus !== false;
  const currentlySharing = isSharing(session.id);

  const shareSeparator = document.createElement('div');
  shareSeparator.className = 'tab-context-menu-separator';

  const shareItem = document.createElement('div');
  shareItem.className = 'tab-context-menu-item' + (!isCli || currentlySharing ? ' disabled' : '');
  shareItem.textContent = 'Share Session\u2026';
  if (isCli && !currentlySharing) {
    shareItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      showShareDialog(session.id);
    });
  }

  const stopShareItem = document.createElement('div');
  stopShareItem.className = 'tab-context-menu-item' + (!currentlySharing ? ' disabled' : '');
  stopShareItem.textContent = 'Stop Sharing';
  if (currentlySharing) {
    stopShareItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      endShare(session.id);
    });
  }

  menu.appendChild(renameItem);
  if (isPrimaryWindow()) {
    menu.appendChild(moveLeftItem);
    menu.appendChild(moveRightItem);
  }

  const detachable = isDetachable(session, isSharing(session.id));
  const detachItem = document.createElement('div');
  detachItem.className = 'tab-context-menu-item' + (detachable ? '' : ' disabled');
  detachItem.textContent = 'Move to New Window';
  if (!detachable) {
    detachItem.title = session.type === 'remote-terminal' ? "Can't move a P2P session"
      : session.type === 'sleepy' ? "Can't move a sleepy pane"
      : "Can't move while sharing";
  }
  if (detachable) {
    detachItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      window.nightyard.windows.moveToNewWindow(session.id);
    });
  }
  menu.appendChild(detachItem);

  if (appState.preferences.debugMode) {
    const sessionSeparator = document.createElement('div');
    sessionSeparator.className = 'tab-context-menu-separator';

    const cliSessionId = session.cliSessionId;
    const hasCliSession = !!cliSessionId;

    const copySessionIdItem = document.createElement('div');
    copySessionIdItem.className = 'tab-context-menu-item' + (!hasCliSession ? ' disabled' : '');
    copySessionIdItem.textContent = 'Copy CLI Session ID';
    if (hasCliSession) {
      copySessionIdItem.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTabContextMenu();
        navigator.clipboard.writeText(cliSessionId);
      });
    }

    const copyInternalIdItem = document.createElement('div');
    copyInternalIdItem.className = 'tab-context-menu-item';
    copyInternalIdItem.textContent = 'Copy Internal ID';
    copyInternalIdItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      navigator.clipboard.writeText(session.id);
    });

    menu.appendChild(sessionSeparator);
    menu.appendChild(copyInternalIdItem);
    menu.appendChild(copySessionIdItem);
  }

  // Inspect item — only for CLI sessions
  const inspectItem = document.createElement('div');
  const isCurrentlyInspecting = isInspectorOpen() && getInspectedSessionId() === session.id;
  inspectItem.className = 'tab-context-menu-item' + (!canInspect ? ' disabled' : '');
  inspectItem.textContent = isCurrentlyInspecting ? 'Close Inspector' : 'Inspect';
  if (canInspect) {
    inspectItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      if (isCurrentlyInspecting) {
        closeInspector();
      } else {
        openInspector(session.id);
      }
    });
  }

  const moveSeparator = document.createElement('div');
  moveSeparator.className = 'tab-context-menu-separator';
  menu.appendChild(moveSeparator);
  if (isPrimaryWindow() && (isCli || isRemote)) {
    menu.appendChild(shareSeparator);
    if (!currentlySharing) menu.appendChild(shareItem);
    if (currentlySharing) menu.appendChild(stopShareItem);
  }
  if (isPrimaryWindow() && canInspect) {
    const inspectSeparator = document.createElement('div');
    inspectSeparator.className = 'tab-context-menu-separator';
    menu.appendChild(inspectSeparator);
    menu.appendChild(inspectItem);
  }

  // Resume with <other provider> — only for CLI sessions
  if (isPrimaryWindow() && isCli) {
    const items = buildResumeWithProviderItems(
      (session.providerId || 'claude') as ProviderId,
      (targetId) => {
        hideTabContextMenu();
        appState.resumeWithProvider(project.id, { sessionId: session.id }, targetId);
      },
    );
    for (const el of items) menu.appendChild(el);
  }

  menu.appendChild(closeItem);
  if (isPrimaryWindow()) {
    menu.appendChild(separator);
    menu.appendChild(closeAllItem);
    menu.appendChild(closeOthersItem);
    menu.appendChild(closeRightItem);
    menu.appendChild(closeLeftItem);
  }
  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Adjust if menu goes off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}

function hideTabContextMenu(): void {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

function render(): void {
  if (tabListEl.querySelector('.tab-name input')) return;
  tabListEl.innerHTML = '';
  const defaultProviderId = appState.preferences.defaultProvider ?? 'claude';
  btnAddSession.title = `New ${getProviderDisplayName(defaultProviderId)} Session (Ctrl+Shift+N)`;
  const project = appState.activeProject;
  if (isPrimaryWindow() && !project) return;

  for (const session of visibleSessions(project)) {
    // Host windows can show sessions from any project — resolve the owner per tab.
    const owner = appState.findSessionWithProject(session.id)?.project ?? project!;
    const tab = document.createElement('div');
    const isActive = isPrimaryWindow()
      ? session.id === project!.activeSessionId
      : session.id === myActiveSessionId();
    const isMcp = session.type === 'mcp-inspector';
    const isDiff = session.type === 'diff-viewer';
    const isFileReader = session.type === 'file-reader';
    const isRemoteTab = session.type === 'remote-terminal';
    const isBrowserTab = session.type === 'browser-tab';
    const isProjectTab = session.type === 'project-tab';
    const unread = !isActive && (isProjectTab ? hasGithubUnread(owner.id) : isUnread(session.id));
    const isKanban = session.type === 'kanban';
    const isTeam = session.type === 'team';
    const isCounsel = session.type === 'counsel';
    const isSpecial = isMcp || isDiff || isFileReader || isRemoteTab || isBrowserTab || isProjectTab || isKanban || isTeam || isCounsel;
    const sharing = isSharing(session.id);
    const displayName = isProjectTab ? `${owner.name} - Overview` : isKanban ? `${owner.name} - Kanban` : isTeam ? `${owner.name} - Team` : isCounsel ? `${owner.name} - Counsel` : session.name;
    tab.className = 'tab-item' + (isActive ? ' active' : '') + (unread ? ' unread' : '') + (sharing ? ' tab-sharing' : '') + (isRemoteTab ? ' tab-remote' : '');
    tab.dataset.sessionId = session.id;
    tab.draggable = true;
    tab.title = isDiff ? `Diff: ${session.diffFilePath || session.name}` : isMcp ? `MCP Inspector` : isFileReader ? `File: ${session.fileReaderPath || session.name}` : isRemoteTab ? `Remote: ${session.remoteHostName || session.name}` : isBrowserTab ? `Browser: ${session.browserTabUrl || 'New Tab'}` : isProjectTab ? 'Project tools' : isKanban ? 'Kanban board' : isTeam ? 'Team' : isCounsel ? 'Counsel' : buildTooltip(getStatus(session.id), session.cliSessionId);
    const providerId = session.providerId || 'claude';
    const providerIcon = hasMultipleAvailableProviders() ? `<img class="tab-provider-icon" src="assets/providers/${providerId}.png" alt="${providerId}" onerror="this.style.display='none'"> ` : '';
    const namePrefix = isDiff ? '<span class="tab-diff-badge">DIFF</span> ' : isMcp ? '<span class="tab-mcp-badge">MCP</span> ' : isFileReader ? '<span class="tab-file-badge">FILE</span> ' : isRemoteTab ? '<span class="tab-remote-badge">P2P</span> ' : isBrowserTab ? '<span class="tab-browser-badge">WEB</span> ' : isProjectTab ? '<span class="tab-project-badge">&#x2699;</span> ' : isKanban ? '<span class="tab-kanban-badge">&#x25A6;</span> ' : isTeam ? '<span class="tab-team-badge">TEAM</span> ' : !isSpecial ? providerIcon : '';
    const shareIndicator = sharing ? '<span class="tab-share-indicator" title="Sharing"></span>' : '';
    const statusDot = isSpecial ? '' : `<span class="tab-status ${getStatus(session.id)}"></span>`;
    tab.innerHTML = `
      ${statusDot}
      <span class="tab-name">${namePrefix}${esc(displayName)}</span>
      ${shareIndicator}
      <span class="tab-close" title="Close session">&times;</span>
    `;

    if (isWakeyOn(session.id)) {
      const badge = document.createElement('span');
      badge.className = 'tab-wakey-badge';
      const phase = runPhaseToEyes(getPhase(session.id), hasRunErrors(session.id));
      const n = getIterations(session.id);
      badge.innerHTML = `${eyesSpan(phase)} ${n > 0 ? n : ''}`.trim();
      tab.querySelector('.tab-close')!.before(badge);
    }

    // Click to switch
    tab.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('tab-close')) return;
      if (tab.querySelector('.tab-name input')) return;
      if (isPrimaryWindow()) {
        if (session.id !== owner.activeSessionId || owner.id !== appState.activeProjectId) {
          appState.setActiveSession(owner.id, session.id);
        }
      } else if (session.id !== myActiveSessionId()) {
        setMyActiveSession(session.id);
        render();
      }
    });

    // Middle-click to close
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeSessionWithConfirm(owner.id, session.id);
      }
    });

    // Double-click to rename
    tab.addEventListener('dblclick', () => startRename(tab, owner, session));

    // Right-click context menu
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(e.clientX, e.clientY, owner, session, tab);
    });

    // Close button
    tab.querySelector('.tab-close')!.addEventListener('click', () => {
      closeSessionWithConfirm(owner.id, session.id);
    });

    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', session.id);
      if (isDetachable(session, isSharing(session.id))) {
        writeTabDragPayload(e.dataTransfer!, { sessionId: session.id, sourceWindowId: windowId });
      }
      tab.classList.add('dragging');
    });

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      // Determine left/right half
      const rect = tab.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      tab.classList.remove('drag-over-left', 'drag-over-right');
      if (e.clientX < midX) {
        tab.classList.add('drag-over-left');
      } else {
        tab.classList.add('drag-over-right');
      }
    });

    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over-left', 'drag-over-right');
    });

    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over-left', 'drag-over-right');
      const payload = readTabDragPayload(e.dataTransfer!);
      const draggedId = payload?.sessionId || e.dataTransfer!.getData('text/plain');
      if (!draggedId || draggedId === session.id) return;

      const rect = tab.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;

      if (payload && payload.sourceWindowId !== windowId) {
        // Cross-window drop: take ownership here, at the drop position.
        const visible = visibleSessions(appState.activeProject);
        let targetIndex = visible.findIndex((s) => s.id === session.id);
        if (e.clientX >= midX) targetIndex++;
        window.nightyard.windows.transfer(draggedId, windowId, targetIndex);
        if (isPrimaryWindow()) {
          // Ownership release alone keeps the old project order — honor the drop position.
          const found = appState.findSessionWithProject(draggedId);
          const proj = appState.activeProject;
          if (found && proj && found.project.id === proj.id) {
            let projIndex = proj.sessions.findIndex((s) => s.id === session.id);
            if (e.clientX >= midX) projIndex++;
            const fromIndex = proj.sessions.findIndex((s) => s.id === draggedId);
            if (fromIndex !== -1 && fromIndex < projIndex) projIndex--;
            appState.reorderSession(proj.id, draggedId, projIndex);
          }
        }
        return;
      }

      if (isPrimaryWindow()) {
        let targetIndex = owner.sessions.findIndex(s => s.id === session.id);
        if (e.clientX >= midX) targetIndex++;

        // Adjust for the fact that removing the dragged item shifts indices
        const fromIndex = owner.sessions.findIndex(s => s.id === draggedId);
        if (fromIndex < targetIndex) targetIndex--;

        appState.reorderSession(owner.id, draggedId, targetIndex);
      } else {
        // In-host reorder is a registry move.
        const mine = mySessionIds();
        let targetIndex = mine.indexOf(session.id);
        if (e.clientX >= midX) targetIndex++;
        const fromIndex = mine.indexOf(draggedId);
        if (fromIndex !== -1 && fromIndex < targetIndex) targetIndex--;
        window.nightyard.windows.transfer(draggedId, windowId, targetIndex);
      }
    });

    tab.addEventListener('dragend', (e) => {
      tab.classList.remove('dragging');
      // Clean up all drag indicators
      tabListEl.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => {
        el.classList.remove('drag-over-left', 'drag-over-right');
      });
      // Released outside every Nightyard window → tear off (main hit-tests the
      // point; an ESC-cancel lands inside a window and is ignored there).
      if (e.dataTransfer?.dropEffect === 'none' && isDetachable(session, isSharing(session.id))) {
        window.nightyard.windows.tearOffOutside(session.id, e.screenX, e.screenY);
      }
    });

    tabListEl.appendChild(tab);
  }

  // Update swarm toggle button visual
  btnToggleSwarm.style.color = project?.layout.mode === 'swarm' ? 'var(--accent)' : '';
}

function renderGitStatus(): void {
  const project = appState.activeProject;
  if (!project) {
    gitStatusEl.innerHTML = '';
    return;
  }

  const status = getGitStatus(project.id);
  if (!status || !status.isGitRepo) {
    gitStatusEl.innerHTML = '';
    return;
  }

  const parts: string[] = [];

  if (status.branch) {
    parts.push(`<span class="git-branch">\u2387 ${esc(status.branch)}</span>`);
  }

  const ab: string[] = [];
  if (status.ahead > 0) ab.push(`\u2191${status.ahead}`);
  if (status.behind > 0) ab.push(`\u2193${status.behind}`);
  if (ab.length) {
    parts.push(`<span class="git-ahead-behind">${ab.join(' ')}</span>`);
  }

  if (status.staged > 0) parts.push(`<span class="git-staged">+${status.staged}</span>`);
  if (status.modified > 0) parts.push(`<span class="git-modified">~${status.modified}</span>`);
  if (status.untracked > 0) parts.push(`<span class="git-untracked">?${status.untracked}</span>`);
  if (status.conflicted > 0) parts.push(`<span class="git-conflicted">!${status.conflicted}</span>`);

  gitStatusEl.innerHTML = parts.join(' ');
}

async function showBranchContextMenu(e: MouseEvent): Promise<void> {
  e.stopPropagation();
  hideTabContextMenu();

  const project = appState.activeProject;
  if (!project) return;

  const status = getGitStatus(project.id);
  if (!status || !status.isGitRepo) return;

  const gitPath = getActiveGitPath(project.id);

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';

  // Position below the git status element
  const elRect = gitStatusEl.getBoundingClientRect();
  menu.style.left = `${elRect.left}px`;
  menu.style.top = `${elRect.bottom + 4}px`;

  // Show loading
  const loadingItem = document.createElement('div');
  loadingItem.className = 'tab-context-menu-item disabled';
  loadingItem.textContent = 'Loading branches\u2026';
  menu.appendChild(loadingItem);

  document.body.appendChild(menu);
  activeContextMenu = menu;

  try {
    const branches = await window.nightyard.git.listBranches(gitPath);

    // Menu was dismissed during loading
    if (activeContextMenu !== menu) return;

    menu.innerHTML = '';
    menu.addEventListener('click', (ev) => ev.stopPropagation());

    const searchInput = document.createElement('input');
    searchInput.className = 'branch-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter branches\u2026';
    menu.appendChild(searchInput);

    const container = document.createElement('div');
    container.className = 'branch-list-container';
    menu.appendChild(container);

    let filteredBranches = branches;
    let activeIndex = 0;
    let itemElements: HTMLElement[] = [];

    function renderBranchItems(query: string): void {
      const lowerQuery = query.toLowerCase();
      filteredBranches = lowerQuery
        ? branches.filter(b => b.name.toLowerCase().includes(lowerQuery))
        : branches;
      activeIndex = 0;
      itemElements = [];
      container.innerHTML = '';

      if (filteredBranches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tab-context-menu-item disabled';
        empty.textContent = 'No matching branches';
        container.appendChild(empty);
        return;
      }

      for (let i = 0; i < filteredBranches.length; i++) {
        const branch = filteredBranches[i];
        const item = document.createElement('div');
        item.className = 'tab-context-menu-item'
          + (branch.current ? ' active' : '')
          + (i === activeIndex ? ' keyboard-active' : '');
        item.textContent = (branch.current ? '\u2713 ' : '  ') + branch.name;

        item.addEventListener('mouseenter', () => {
          activeIndex = i;
          setActiveHighlight();
        });

        if (!branch.current) {
          item.addEventListener('click', () => {
            hideTabContextMenu();
            switchBranch(gitPath, branch.name);
          });
        }
        itemElements.push(item);
        container.appendChild(item);
      }
    }

    function setActiveHighlight(): void {
      itemElements.forEach((el, i) => {
        el.classList.toggle('keyboard-active', i === activeIndex);
      });
    }

    function setActiveAndScroll(): void {
      setActiveHighlight();
      itemElements[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    searchInput.addEventListener('input', () => renderBranchItems(searchInput.value));

    searchInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      switch (ev.key) {
        case 'ArrowDown':
          ev.preventDefault();
          if (filteredBranches.length > 0) {
            activeIndex = (activeIndex + 1) % filteredBranches.length;
            setActiveAndScroll();
          }
          break;
        case 'ArrowUp':
          ev.preventDefault();
          if (filteredBranches.length > 0) {
            activeIndex = (activeIndex - 1 + filteredBranches.length) % filteredBranches.length;
            setActiveAndScroll();
          }
          break;
        case 'Enter':
          ev.preventDefault();
          if (activeIndex < filteredBranches.length) {
            const selected = filteredBranches[activeIndex];
            if (!selected.current) {
              hideTabContextMenu();
              switchBranch(gitPath, selected.name);
            }
          }
          break;
        case 'Escape':
          ev.preventDefault();
          hideTabContextMenu();
          break;
      }
    });

    renderBranchItems('');

    // Separator + Create New Branch
    const separator = document.createElement('div');
    separator.className = 'tab-context-menu-separator';
    menu.appendChild(separator);

    const createItem = document.createElement('div');
    createItem.className = 'tab-context-menu-item';
    createItem.textContent = 'Create New Branch\u2026';
    createItem.addEventListener('click', () => {
      hideTabContextMenu();
      promptCreateBranch(gitPath);
    });
    menu.appendChild(createItem);

    // Adjust if off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

    searchInput.focus();
  } catch {
    if (activeContextMenu !== menu) return;
    menu.innerHTML = '';
    const errItem = document.createElement('div');
    errItem.className = 'tab-context-menu-item disabled';
    errItem.textContent = 'Failed to load branches';
    menu.appendChild(errItem);
  }
}

async function switchBranch(gitPath: string, branchName: string): Promise<void> {
  const project = appState.activeProject;
  const freshStatus = project ? getGitStatus(project.id) : null;
  const dirty = freshStatus ? freshStatus.staged + freshStatus.modified + freshStatus.conflicted : 0;
  if (dirty > 0) {
    const confirmed = confirm(`You have uncommitted changes. Switch to "${branchName}" anyway?`);
    if (!confirmed) return;
  }

  try {
    await window.nightyard.git.checkoutBranch(gitPath, branchName);
    refreshGitStatus();
  } catch (err) {
    alert(`Failed to switch branch: ${err instanceof Error ? err.message : err}`);
  }
}

function promptCreateBranch(gitPath: string): void {
  showModal('Create New Branch', [
    { label: 'Branch name', id: 'branch-name', placeholder: 'feature/my-branch' },
  ], async (values) => {
    const name = values['branch-name']?.trim();
    if (!name) {
      setModalError('branch-name', 'Branch name is required');
      return;
    }
    if (/\s/.test(name)) {
      setModalError('branch-name', 'Branch name cannot contain spaces');
      return;
    }
    try {
      await window.nightyard.git.createBranch(gitPath, name);
      closeModal();
      refreshGitStatus();
    } catch (err) {
      setModalError('branch-name', err instanceof Error ? err.message : 'Failed to create branch');
    }
  });
}

export function quickNewSession(): void {
  let project = appState.activeProject;
  if (!isPrimaryWindow()) {
    // ⊕ in a host window spawns into the active tab's project and keeps the tab here.
    const activeId = myActiveSessionId();
    project = (activeId ? appState.findSessionWithProject(activeId)?.project : undefined) ?? project;
  }
  if (!project) return;
  (document.activeElement as HTMLElement)?.blur?.();
  const sessionNum = project.sessions.length + 1;
  const session = appState.addSession(project.id, `Session ${sessionNum}`);
  if (session && !isPrimaryWindow()) {
    window.nightyard.windows.transfer(session.id, windowId, mySessionIds().length);
  }
}

/**
 * Quick-create a session for a specific provider (e.g. Codex), mirroring quickNewSession.
 * An explicit Codex account is remembered for the project, like a pick in the New Session dialog.
 */
function newSessionWithProvider(providerId: ProviderId, account?: string): void {
  const project = appState.activeProject;
  if (!project) return;
  (document.activeElement as HTMLElement)?.blur?.();
  const sessionNum = project.sessions.length + 1;
  if (providerId === 'codex' && account) project.defaultAccount = account;
  appState.addSession(project.id, `Session ${sessionNum}`, undefined, providerId, account);
}

async function showAddSessionContextMenu(x: number, y: number): Promise<void> {
  hideTabContextMenu();

  // Codex can run under several logins (CODEX_HOME dirs, see main/codex-homes.ts);
  // each one gets its own quick item below. A failed lookup just keeps the single item.
  const codexAccounts = getProviderAvailabilitySnapshot()?.availability.get('codex')
    ? await window.nightyard.codex.listAccounts().catch(() => [])
    : [];
  // A second click can land while the lookup is in flight; only one menu may be open.
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // One "New <provider> Session" item per installed provider, so spawning a
  // Codex (or Gemini/Copilot) tab is a single click. When only one provider is
  // available, fall back to a single generic "New Session" (Claude quick path).
  const snapshot = getProviderAvailabilitySnapshot();
  const availableProviders = snapshot
    ? snapshot.providers.filter((p) => snapshot.availability.get(p.id))
    : [];

  const newSessionItems: HTMLElement[] = [];
  if (availableProviders.length > 1) {
    for (const p of availableProviders) {
      const entries = p.id === 'codex'
        ? codexSessionMenuEntries(p.displayName, codexAccounts)
        : [{ text: `New ${p.displayName} Session`, account: undefined, title: undefined }];
      for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'tab-context-menu-item';
        item.innerHTML =
          `<img class="menu-provider-icon" src="assets/providers/${p.id}.png" alt="" ` +
          `onerror="this.style.display='none'"> ${esc(entry.text)}`;
        if (entry.title) item.title = entry.title;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          hideTabContextMenu();
          newSessionWithProvider(p.id, entry.account);
        });
        newSessionItems.push(item);
      }
    }
  } else {
    const quickItem = document.createElement('div');
    quickItem.className = 'tab-context-menu-item';
    quickItem.textContent = 'New Session';
    quickItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      quickNewSession();
    });
    newSessionItems.push(quickItem);
  }

  const customItem = document.createElement('div');
  customItem.className = 'tab-context-menu-item';
  customItem.textContent = 'New Custom Session\u2026';
  customItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    promptNewSession();
  });

  const joinSeparator = document.createElement('div');
  joinSeparator.className = 'tab-context-menu-separator';

  const joinItem = document.createElement('div');
  joinItem.className = 'tab-context-menu-item';
  joinItem.textContent = 'Join Remote Session\u2026';
  joinItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    showJoinDialog();
  });

  const browserItem = document.createElement('div');
  browserItem.className = 'tab-context-menu-item';
  browserItem.textContent = 'New Browser Tab';
  browserItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    const project = appState.activeProject;
    if (project) appState.addBrowserTabSession(project.id);
  });

  for (const item of newSessionItems) menu.appendChild(item);
  menu.appendChild(customItem);
  menu.appendChild(browserItem);
  menu.appendChild(joinSeparator);
  menu.appendChild(joinItem);
  document.body.appendChild(menu);
  activeContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}

export async function promptNewSession(onCreated?: (session: SessionRecord) => void): Promise<void> {
  const project = appState.activeProject;
  if (!project) return;

  const sessionNum = project.sessions.length + 1;

  let providerSnapshot = getProviderAvailabilitySnapshot();
  if (!providerSnapshot) {
    await loadProviderAvailability();
    providerSnapshot = getProviderAvailabilitySnapshot();
  }
  const providers = providerSnapshot?.providers ?? [];
  const availabilityMap = providerSnapshot?.availability ?? new Map();

  const fields: FieldDef[] = [
    { label: 'Name', id: 'session-name', placeholder: `Session ${sessionNum}`, defaultValue: `Session ${sessionNum}` },
    { label: 'Arguments', id: 'session-args', placeholder: 'e.g. --model sonnet', defaultValue: mergeDefaultArgs(appState.preferences.globalDefaultArgs, project.defaultArgs) },
    {
      label: 'Keep args for future sessions',
      id: 'keep-args',
      type: 'checkbox',
      defaultValue: project.defaultArgs ? 'true' : undefined,
    },
  ];

  // Codex can run under several logins (CODEX_HOME dirs, see main/codex-homes.ts).
  // Only offer a choice when there is one to make.
  const codexAccounts = availabilityMap.get('codex') ? await window.nightyard.codex.listAccounts() : [];
  if (codexAccounts.length > 1) {
    const remembered = project.defaultAccount;
    const preselected = remembered && codexAccounts.some(a => a.id === remembered) ? remembered : 'default';
    fields.splice(2, 0, {
      label: 'Codex account',
      id: 'codex-account',
      type: 'select',
      defaultValue: preselected,
      options: codexAccounts.map(a => ({ value: a.id, label: a.label })),
    });
  }

  if (providers.length > 1) {
    const preferred = appState.preferences.defaultProvider ?? 'claude';
    const firstAvailable = (availabilityMap.get(preferred) ? preferred : providers.find(p => availabilityMap.get(p.id))?.id) ?? 'claude';
    fields.unshift({
      label: 'Provider',
      id: 'provider',
      type: 'select',
      defaultValue: firstAvailable,
      options: providers.map(p => {
        const available = availabilityMap.get(p.id);
        return { value: p.id, label: available ? p.displayName : `${p.displayName} (not installed)`, disabled: !available };
      }),
    });
  }

  showModal('New Session', fields, (values) => {
    const name = values['session-name']?.trim();
    if (name) {
      closeModal();
      const args = values['session-args']?.trim() || undefined;
      const keepArgs = values['keep-args'] === 'true';
      project.defaultArgs = keepArgs ? (args || undefined) : undefined;
      const providerId = (values['provider'] || 'claude') as ProviderId;
      const pickedAccount = values['codex-account'] || undefined;
      if (providerId === 'codex' && pickedAccount) project.defaultAccount = pickedAccount;
      const session = appState.addSession(project.id, name, args, providerId, providerId === 'codex' ? pickedAccount : undefined);
      if (session && onCreated) onCreated(session);
    }
  });
}

function promptNewMcpInspector(): void {
  const project = appState.activeProject;
  if (!project) return;

  const inspectorNum = project.sessions.filter(s => s.type === 'mcp-inspector').length + 1;
  showModal('New MCP Inspector', [
    { label: 'Name', id: 'inspector-name', placeholder: `Inspector ${inspectorNum}`, defaultValue: `Inspector ${inspectorNum}` },
  ], (values) => {
    const name = values['inspector-name']?.trim();
    if (name) {
      closeModal();
      appState.addMcpInspectorSession(project.id, name);
    }
  });
}

function esc(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}
