import { appState } from '../state.js';
import { summarizeBoard } from '../board-state.js';
import type { WakeyRun, WakeySnapshot } from '../../shared/types.js';

/**
 * The renderer no longer runs the Wakey supervision loop — that lives in the
 * main process (`src/main/wakey/wakey-core.ts`). This module is a thin mirror:
 * it forwards user intent (toggle/stop/dismiss/restart) over IPC and reflects
 * whatever WakeySnapshot the core last pushed. There is no local timer, no
 * cooldown bookkeeping, no supervise call — all of that is main-process state.
 */

// Kept narrow (matches the pre-mirror contract) so the v1 status panel's
// `{idle,thinking,typing,stopped}` lookup table keeps compiling untouched.
// An ACTIVE run (see isActiveRun below) can never actually be 'stopped' or
// 'orphaned' — those states always imply the run stopped being active — so
// this is a true narrowing of what getPhase can return, not a lossy cast.
export type WakeyPhase = 'idle' | 'thinking' | 'typing' | 'stopped';

let snapshot: WakeySnapshot = { runs: [], projectDefaults: {} };
const listeners: Array<() => void> = [];

function notify(): void {
  for (const cb of listeners) cb();
}

/** Local copy of run-store's `isActive` predicate — main is the source of truth,
 *  but the renderer can't import from src/main, so this one-liner is replicated. */
function isActiveRun(run: WakeyRun): boolean {
  return !run.stop && !run.dismissed && run.phase !== 'orphaned';
}

function activeRunForSession(sessionId: string): WakeyRun | undefined {
  return snapshot.runs.find((r) => r.sessionId === sessionId && isActiveRun(r));
}

export function isWakeyOn(sessionId: string): boolean {
  return !!activeRunForSession(sessionId);
}

export function getIterations(sessionId: string): number {
  return activeRunForSession(sessionId)?.iterations ?? 0;
}

export function getPhase(sessionId: string): WakeyPhase {
  const run = activeRunForSession(sessionId);
  if (!run) return 'idle';
  return run.phase === 'thinking' || run.phase === 'typing' ? run.phase : 'idle';
}

/**
 * True iff the session's ACTIVE run (same lookup as the other accessors —
 * so a stopped/orphaned/dismissed run never counts) is currently erroring.
 * Lets the tab badge show the error eyes for the same run the panel already
 * renders `(x.x)` for, without the mirror having to widen `WakeyPhase` itself.
 */
export function hasRunErrors(sessionId: string): boolean {
  return (activeRunForSession(sessionId)?.consecutiveErrors ?? 0) > 0;
}

export function getLastPrompt(sessionId: string): string {
  return activeRunForSession(sessionId)?.lastSteer ?? '';
}

export function getDirection(sessionId: string): string {
  return activeRunForSession(sessionId)?.direction ?? '';
}

export function listEnabledSessions(): string[] {
  return snapshot.runs.filter(isActiveRun).map((r) => r.sessionId);
}

/** ALL non-dismissed runs, including stopped/orphaned ones — for the panel. */
export function getRuns(): WakeyRun[] {
  return snapshot.runs;
}

export function onWakeyChange(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function _resetForTesting(): void {
  snapshot = { runs: [], projectDefaults: {} };
  listeners.length = 0;
  (globalThis as any).__wakeyMirrorInit = false;
}

/**
 * Toggle Wakey for a session. Always sends the same `wakey.toggle` IPC — the
 * main-process core decides whether this starts a new run or stops the
 * session's active one. Fire-and-forget: the pushed WakeySnapshot (via
 * `onState`) is what actually updates the UI.
 */
export function toggleWakey(sessionId: string, direction?: string): void {
  const project = appState.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
  const session = project?.sessions.find((s) => s.id === sessionId);
  if (!project || !session) return;
  const trimmed = direction?.trim();
  void window.nightyard.wakey.toggle({
    sessionId,
    projectId: project.id,
    projectPath: project.path,
    cliSessionId: session.cliSessionId,
    direction: trimmed || undefined,
    boardContext: summarizeBoard(project.board),
  });
}

/**
 * Stop Wakey for a session. Idempotent on the main-process side; safe to call
 * whether or not Wakey is currently on for this session.
 */
export function stopWakey(sessionId: string): void {
  void window.nightyard.wakey.stop(sessionId);
}

export function dismissRun(runId: string): void {
  void window.nightyard.wakey.dismiss(runId);
}

/**
 * Restart a stopped/orphaned run. If the run's session is still alive in
 * appState, re-toggle it directly (same session id, same CLI session id via
 * the live lookup in toggleWakey). Otherwise the session is gone — spawn a
 * fresh one in the run's project and toggle that instead.
 */
export function restartRun(runId: string): void {
  const run = snapshot.runs.find((r) => r.runId === runId);
  if (!run) return;
  if (isActiveRun(run)) return; // already running — restarting would stop it via toggle's flip semantics

  const sessionStillAlive = appState.projects.some((p) => p.sessions.some((s) => s.id === run.sessionId));
  if (sessionStillAlive) {
    toggleWakey(run.sessionId, run.direction ?? undefined);
    return;
  }

  const project = appState.projects.find((p) => p.id === run.projectId)
    ?? appState.projects.find((p) => p.path === run.projectPath);
  if (!project) return;

  const newSession = appState.addSession(project.id, 'wakey');
  if (newSession) {
    toggleWakey(newSession.id, run.direction ?? undefined);
  }
}

/**
 * Persist a default Wakey steering direction for the project (appState, so it
 * survives restarts) and push it to the live core so an already-running
 * project immediately picks up the new default on its next cycle.
 */
export function setProjectDefaultDirection(projectId: string, direction: string): void {
  appState.setProjectDefaultDirection(projectId, direction);
  void window.nightyard.wakey.setProjectDefault(projectId, direction);
}

/**
 * Resolve the effective Wakey direction for a session:
 * session direction (trimmed, non-empty) wins; else project default; else undefined.
 */
export function effectiveDirection(projectId: string, sessionDirection: string | undefined): string | undefined {
  const trimmedSession = sessionDirection?.trim();
  if (trimmedSession) return trimmedSession;
  const project = appState.projects.find((p) => p.id === projectId);
  const def = project?.wakeyDefaultDirection?.trim();
  return def || undefined;
}

const BOARD_REFRESH_MS = 5 * 60_000;

/**
 * Re-seed main's in-memory `projectDefaults` map from the persisted
 * `project.wakeyDefaultDirection` on every project. Main only ever learns a
 * default via the `wakey:set-project-default` IPC (fired live from
 * `setProjectDefaultDirection`) — it never reads the persisted project
 * records itself. Without this, a default saved in a prior app session is
 * invisible to main after a restart: `opts.direction || projectDefaults.get(projectId)`
 * resolves to nothing and a resumed run supervises undirected, silently.
 * Only forwards projects that actually have a non-empty default — sending one
 * for every project (including those without a default) would otherwise
 * spam `wakey:set-project-default` with no-op clears.
 */
function seedProjectDefaults(): void {
  for (const project of appState.projects) {
    const trimmed = project.wakeyDefaultDirection?.trim();
    if (trimmed) void window.nightyard.wakey.setProjectDefault(project.id, trimmed);
  }
}

function sendHello(): void {
  // Seed BEFORE hello: a resumed run's next supervision cycle reads
  // projectDefaults synchronously off the same core, so the default must
  // already be in place by the time hello lands.
  seedProjectDefaults();
  const sessions = appState.projects.flatMap((project) =>
    project.sessions.map((session) => ({
      sessionId: session.id,
      cliSessionId: session.cliSessionId,
      projectId: project.id,
      projectPath: project.path,
    })),
  );
  void window.nightyard.wakey.hello(sessions);
}

/**
 * Initialize the Wakey mirror for this window: subscribe to pushed snapshots,
 * fetch the current one, announce this window's live sessions to the core
 * (`hello`, so persisted runs can rebind after a restart), tear down a
 * session's run when the session itself closes, and keep board context fresh
 * for projects with an active run.
 *
 * Called from BOTH window paths in index.ts (primary + detached host) — the
 * supervision loop lives in main now, so every window is just a mirror.
 *
 * Hello timing: the primary window calls this BEFORE awaiting
 * `appState.load()`, so `appState.projects` can still be empty here. The
 * host-window path awaits `appState.load()` first, so projects are already
 * populated by the time this runs. To cover both without racing the loader,
 * send `hello` immediately when projects are already present; otherwise wait
 * for the one-time `state-loaded` event that `appState.load()` emits once
 * persisted state is applied, then send it from there instead.
 */
export function initWakeyMirror(): void {
  if ((globalThis as any).__wakeyMirrorInit) return;
  (globalThis as any).__wakeyMirrorInit = true;

  window.nightyard.wakey.onState((s) => {
    snapshot = s;
    notify();
  });
  void window.nightyard.wakey.getState().then((s) => {
    snapshot = s;
    notify();
  });

  if (appState.projects.length > 0) {
    sendHello();
  } else {
    const off = appState.on('state-loaded', () => {
      off();
      sendHello();
    });
  }

  // Closing a session/tab must also tear down its Wakey run — otherwise the
  // badge and panel row outlive the session with no UI left to stop it from.
  appState.on('session-removed', (payload: unknown) => {
    const sid = (payload as { sessionId?: string } | undefined)?.sessionId;
    if (sid) stopWakey(sid);
  });

  // Keep the supervisor's board snapshot fresh for projects that currently
  // own an active run — the board can change while Wakey is mid-run.
  setInterval(() => {
    const activeProjectIds = new Set(snapshot.runs.filter(isActiveRun).map((r) => r.projectId));
    if (activeProjectIds.size === 0) return;
    for (const project of appState.projects) {
      if (!activeProjectIds.has(project.id)) continue;
      void window.nightyard.wakey.boardContext(project.id, summarizeBoard(project.board) ?? '');
    }
  }, BOARD_REFRESH_MS);
}
