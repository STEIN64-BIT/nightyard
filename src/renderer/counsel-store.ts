import { appState } from './state.js';
import type {
  CounselEvent,
  CounselModeratorNote,
  CounselResult,
  CounselSeat,
  CounselSeatConfig,
  CounselStartConfig,
  CounselVerdict,
} from '../shared/types.js';

export interface ActiveCounsel {
  counselId: string;
  projectId: string;
  seats: Record<CounselSeat, CounselSeatConfig>;
  turns: Array<{ turnId: string; seat: CounselSeat; round: number; text: string; done: boolean }>;
  moderatorNotes: CounselModeratorNote[];
  contextBrief: string | null | undefined; // undefined = pending, null = failed/skipped
  status: 'context' | 'debating' | 'moderating' | 'adjudicating' | 'done';
  activeSeat: CounselSeat | null;
  verdict: CounselVerdict | null;
  error: string | null;
}

const HISTORY_CAP = 20;

let active: ActiveCounsel | null = null;
const listeners = new Set<() => void>();
let unsubscribeEvents: (() => void) | null = null;

// The main process may emit 'start' (and, when contextPass is false, the
// first 'turn-start') synchronously — before the counsel:start invoke's
// reply reaches the renderer. While a startCounsel() call is in flight we
// don't yet know the resolved counselId (and `active` isn't set yet), so
// events would otherwise be dropped by the stale-id guard below. Buffer them
// instead and replay through the normal handler once `active` exists.
let startInFlight = false;
let eventBuffer: CounselEvent[] = [];

function notify(): void {
  for (const cb of listeners) cb();
}

function ensureSubscribed(): void {
  if (unsubscribeEvents) return;
  unsubscribeEvents = window.nightyard.counsel.onEvent(handleEvent);
}

function handleEvent(event: CounselEvent): void {
  if (startInFlight) {
    eventBuffer.push(event);
    return;
  }
  processEvent(event);
}

function processEvent(event: CounselEvent): void {
  if (!active || event.counselId !== active.counselId) return;

  switch (event.type) {
    case 'start':
      // Nothing to do — startCounsel() already built the initial ActiveCounsel
      // from the config it was given, before this event could arrive.
      break;

    case 'context':
      active.contextBrief = event.brief;
      active.status = 'debating';
      break;

    case 'turn-start':
      active.turns.push({ turnId: event.turnId, seat: event.seat, round: event.round, text: '', done: false });
      active.activeSeat = event.seat;
      active.status = 'debating';
      break;

    case 'turn-delta': {
      const turn = active.turns.find((t) => t.turnId === event.turnId);
      if (turn) turn.text += event.chunk;
      break;
    }

    case 'turn-end': {
      const turn = active.turns.find((t) => t.turnId === event.turnId);
      if (turn) {
        turn.text = event.fullText;
        turn.done = true;
      }
      break;
    }

    case 'phase':
      active.status = event.phase;
      break;

    case 'moderator':
      active.moderatorNotes.push({ afterRound: event.round, decision: event.decision, note: event.note });
      // On 'continue'/'redirect' the turn loop resumes and the next
      // 'turn-start' event puts status back to 'debating'; on 'converged'
      // the orchestrator immediately emits 'phase: adjudicating'. Either way
      // this transient 'moderating' status is overwritten right after.
      active.status = 'moderating';
      break;

    case 'verdict':
      active.verdict = event.verdict;
      active.status = 'adjudicating';
      break;

    case 'done':
      appendToHistory(active.projectId, event.result);
      active.activeSeat = null;
      active.status = 'done';
      break;

    case 'error':
      active.error = event.message;
      break;
  }

  notify();
}

export async function startCounsel(projectId: string, config: Omit<CounselStartConfig, 'counselId'>): Promise<string> {
  ensureSubscribed();
  startInFlight = true;
  eventBuffer = [];

  let counselId: string;
  try {
    counselId = await window.nightyard.counsel.start(config);
  } catch (err) {
    startInFlight = false;
    eventBuffer = [];
    throw err;
  }
  startInFlight = false;

  active = {
    counselId,
    projectId,
    seats: config.seats,
    turns: [],
    moderatorNotes: [],
    contextBrief: config.contextPass ? undefined : null,
    status: config.contextPass ? 'context' : 'debating',
    activeSeat: null,
    verdict: null,
    error: null,
  };
  notify();

  // Replay anything buffered while the start() invoke was in flight.
  // processEvent() re-checks counselId, so stale events (e.g. a leftover
  // 'done' from a debate that was already superseded) are still ignored.
  const buffered = eventBuffer;
  eventBuffer = [];
  for (const e of buffered) processEvent(e);

  return counselId;
}

export async function stopCounsel(): Promise<void> {
  if (!active) return;
  await window.nightyard.counsel.stop(active.counselId);
}

export function getActiveCounsel(): ActiveCounsel | null {
  return active;
}

/**
 * Clears the singleton active counsel (e.g. once the user is done looking at
 * a finished debate and wants to start a new one). Nothing else ever nulls
 * `active` after a 'done' event — without this, a project's Counsel router
 * would be stuck showing the debate view forever. Safe no-op if nothing is
 * active.
 */
export function clearActiveCounsel(): void {
  if (!active) return;
  active = null;
  notify();
}

export function onCounselChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Append a finished debate to the project's capped history and persist. Exported for tests. */
export function appendToHistory(projectId: string, result: CounselResult): void {
  const project = appState.projects.find((p) => p.id === projectId);
  if (!project) return;
  if (!project.counsels) project.counsels = [];
  project.counsels.push(result);
  if (project.counsels.length > HISTORY_CAP) {
    project.counsels.splice(0, project.counsels.length - HISTORY_CAP);
  }
  appState.notifyCounselChanged();
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  active = null;
  listeners.clear();
  startInFlight = false;
  eventBuffer = [];
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }
}
