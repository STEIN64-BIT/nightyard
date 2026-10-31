import { appState } from '../state.js';
import type { PersistedState } from '../../shared/types.js';

/** Live state sync: another window mutated appState; main relayed its snapshot to us. */
export function initWindowSync(): void {
  window.nightyard.state.onSnapshot((state) => {
    appState.applyExternalSnapshot(state as PersistedState);
  });

  // Fires only in the window that performed the removal (snapshot receivers
  // don't re-emit it), so main's registry gets exactly one release per close.
  appState.on('session-removed', (data) => {
    const d = data as { sessionId?: string } | undefined;
    if (d?.sessionId) window.nightyard.windows.releaseSession(d.sessionId);
  });
}
