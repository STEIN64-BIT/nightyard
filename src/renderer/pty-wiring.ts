import { appState } from './state.js';
import { handlePtyData, destroyTerminal, updateCostDisplay, updateContextDisplay } from './components/terminal-pane.js';
import { setHookStatus, notifyInterrupt } from './session-activity.js';
import { parseCost, setCostData, onChange as onCostChange } from './session-cost.js';
import { parseTitle, clearSession as clearTitleSession } from './session-title.js';
import { setContextData, onChange as onContextChange, getContext } from './session-context.js';
import { captureInitialContext } from './session-insights.js';
import { addEvents as addInspectorEvents } from './session-inspector-state.js';
import { feedInspectorEvents } from './agent-graph-feed.js';
import { applyEvent as applyGraphEvent } from './agent-graph-store.js';
import { handleShellPtyData, handleShellPtyExit, isShellSessionId } from './components/project-terminal.js';
import { isSharing } from './sharing/peer-host.js';
import { forwardPtyData, endShare } from './sharing/share-manager.js';
import { logDebugEvent } from './components/debug-panel.js';
import { isSessionHostedHere } from './window-registry-client.js';
import type { InspectorEvent } from '../shared/types.js';

let quitting = false;

function isMcpSession(sessionId: string): boolean {
  for (const project of appState.projects) {
    const session = project.sessions.find(s => s.id === sessionId);
    if (session) return session.type === 'mcp-inspector';
  }
  return false;
}

/**
 * Wire pty + session event streams from main into this window. Runs in every
 * window; owner guards keep state writes and session closes single-writer
 * (the window hosting a session owns them — others learn via snapshot sync).
 */
export function wirePtyAndSessionEvents(): void {
  window.nightyard.app.onQuitting(() => {
    quitting = true;
  });

  window.nightyard.pty.onData((sessionId, data, seq) => {
    if (isShellSessionId(sessionId)) {
      handleShellPtyData(sessionId, data);
    } else if (!isMcpSession(sessionId)) {
      handlePtyData(sessionId, data, seq);
      parseCost(sessionId, data);
      parseTitle(sessionId, data);
      if (data.includes('Interrupted')) {
        notifyInterrupt(sessionId);
      }
      // Forward to P2P share if active
      if (isSharing(sessionId)) {
        forwardPtyData(sessionId, data);
      }
    }
  });

  window.nightyard.session.onCostData((sessionId, costData) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('costData', sessionId, costData);
    setCostData(sessionId, costData);
    const contextBefore = getContext(sessionId);
    setContextData(sessionId, costData.context_window);
    captureInitialContext(sessionId, costData.context_window);

    // Bridge cost/context into inspector events so Costs & Context tabs work.
    // Only emit when context actually changed (avoids filling the event buffer with duplicates).
    const contextAfter = getContext(sessionId);
    if (contextAfter && contextAfter !== contextBefore) {
      const syntheticEvent: InspectorEvent = {
        type: 'status_update',
        timestamp: Date.now(),
        hookEvent: 'StatusLine',
        cost_snapshot: {
          total_cost_usd: costData.cost.total_cost_usd ?? 0,
          total_duration_ms: costData.cost.total_duration_ms ?? 0,
        },
        context_snapshot: {
          total_tokens: contextAfter.totalTokens,
          context_window_size: contextAfter.contextWindowSize,
          used_percentage: contextAfter.usedPercentage,
        },
      };
      addInspectorEvents(sessionId, [syntheticEvent]);
    }
  });

  onCostChange((sessionId, cost) => {
    updateCostDisplay(sessionId, cost);
    if (isSessionHostedHere(sessionId)) {
      appState.updateSessionCost(sessionId, cost);
    }
  });

  onContextChange((sessionId, info) => {
    updateContextDisplay(sessionId, info);
    if (isSessionHostedHere(sessionId)) {
      appState.updateSessionContext(sessionId, info);
    }
  });

  window.nightyard.session.onHookStatus((sessionId, status, hookName) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('hookStatus', sessionId, hookName ? `${hookName}: ${status}` : status);
    setHookStatus(sessionId, status, hookName);
    applyGraphEvent({ kind: 'session-status', id: sessionId, status });
  });

  window.nightyard.session.onInspectorEvents((sessionId, events) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('inspectorEvents', sessionId, { count: events.length });
    addInspectorEvents(sessionId, events);
    feedInspectorEvents(sessionId, events);
  });

  window.nightyard.session.onCliSessionId((sessionId, cliSessionId) => {
    logDebugEvent('cliSessionId', sessionId, cliSessionId);
    // Single-writer: only the hosting window persists session metadata.
    if (!isSessionHostedHere(sessionId)) return;
    const project = appState.projects.find(p => p.sessions.some(s => s.id === sessionId));
    if (project) {
      clearTitleSession(sessionId);
      appState.updateSessionCliId(project.id, sessionId, cliSessionId);
    }
  });

  window.nightyard.pty.onExit((sessionId, exitCode) => {
    logDebugEvent('ptyExit', sessionId, { exitCode });
    if (isShellSessionId(sessionId)) {
      handleShellPtyExit(sessionId, exitCode);
    } else if (!isMcpSession(sessionId) && !quitting) {
      // Only the hosting window closes the session; others learn via snapshot.
      if (!isSessionHostedHere(sessionId)) return;
      // End any active P2P share for this session
      if (isSharing(sessionId)) {
        endShare(sessionId);
      }
      // Auto-close the session when CLI exits (skip during app quit to preserve session state)
      const project = appState.projects.find(p => p.sessions.some(s => s.id === sessionId));
      if (project) {
        destroyTerminal(sessionId);
        clearTitleSession(sessionId);
        appState.removeSession(project.id, sessionId); // 'session-removed' → registry release
      }
    }
  });
}
