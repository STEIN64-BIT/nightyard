import crypto from 'node:crypto';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { writePty } from '../pty-manager';
import { loadState } from '../store';
import { broadcastToAllWindows } from '../broadcast';
import { superviseOnce, buildUserPrompt, DEFAULT_WAKEY_SYSTEM_PROMPT } from '../wakey-runner';
import { resolveBinary } from '../providers/resolve-binary';
import { isStopResponse } from '../../shared/wakey-stop';
import { onHookStatusMain, onCliSessionIdMain } from '../hook-status';
import type { WakeySnapshot } from '../../shared/types';
import {
  createRun, isActive, recordSteer, recordSupervision, recordFastpath, recordError, recordBrainRestart,
  recentSteers, stopRun, rateCapExceeded, loadRuns, saveRuns, RUNS_FILE,
  MAX_CONSECUTIVE_ERRORS, type WakeyRun,
} from './run-store';
import { readTranscriptDelta, type TranscriptDelta } from './transcript-delta';
import { matchDialog, stripAnsi, type DialogMatch } from './dialog-matcher';
import { shouldForceSupervision } from './watchdog';
import { createWakeyBrain, BRAIN_TURN_CAP, type WakeyBrain } from './wakey-brain';

export type { WakeySnapshot } from '../../shared/types';

/** Screen tail kept per session for the dialog fast-path + typed-steer echo check. */
const TAIL_CAP = 4096;
/** A screen counts as settled once it has not changed for this long. */
const SCREEN_STABLE_MS = 1_500;
/** After answering a dialog, hold off on both supervision and further answers. */
const FASTPATH_COOLDOWN_MS = 3_000;
/** After typing a steer, ignore the self-induced working→completed cascade. */
const STEER_COOLDOWN_MS = 8_000;
/**
 * After throwing a steer away (filler or a repeat) nothing was typed, so the
 * session's own hook storm would otherwise re-trigger us immediately and burn
 * brain turns in a hot loop. Breathe before asking again.
 */
const REJECTED_STEER_COOLDOWN_MS = 3_000;
/** Claude Code's Ink input drops a `\r` glued to the same chunk — split the write. */
const ENTER_DELAY_MS = 80;
const ECHO_TIMEOUT_MS = 1_500;
const ECHO_POLL_MS = 100;
const ECHO_PREFIX_CHARS = 20;
const BROADCAST_DEBOUNCE_MS = 100;
const PERSIST_DEBOUNCE_MS = 500;
/** Grace for a persisted run whose session did not come back after a restart. */
const ORPHAN_GRACE_MS = 60_000;
/** Dispose the persistent brain of a run that has not been supervised in this long. */
const BRAIN_IDLE_MS = 30 * 60_000;
/** Drop the screen tail of a silent session that no run points at any more. */
const PTY_STATE_TTL_MS = 30 * 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const FASTPATH_INTERVAL_MS = 2_000;
const PREFS_CACHE_MS = 60_000;
const FILLER = /^(continue|ok|okay|go ahead|next|proceed|keep going)\.?$/i;

const DEFAULT_PREFS: WakeyPrefs = {
  wakeyMaxIterations: 50,
  wakeySystemPrompt: DEFAULT_WAKEY_SYSTEM_PROMPT,
  wakeyModel: 'sonnet',
  wakeyWatchdogMinutes: 3,
};

export interface WakeyPrefs {
  wakeyMaxIterations: number;
  wakeySystemPrompt: string;
  wakeyModel: string;
  wakeyWatchdogMinutes: number;
}

export interface WakeyToggleOpts {
  sessionId: string;
  projectId: string;
  projectPath: string;
  cliSessionId: string | null;
  direction?: string;
  boardContext?: string;
}

export interface WakeyHelloSession {
  sessionId: string;
  cliSessionId: string | null;
  projectId: string;
  projectPath: string;
}

/** Everything the core touches outside itself, so the whole loop is testable. */
export interface WakeyCoreDeps {
  writePty(sessionId: string, data: string): void;
  readDelta(cwd: string, cli: string, offset: number): TranscriptDelta;
  matchDialog(tail: string): DialogMatch | null;
  brainFactory(model: string, systemPrompt: string): WakeyBrain;
  superviseFallback(opts: { cwd: string; sessionId: string; systemPrompt: string; userPrompt: string }): Promise<string>;
  loadPrefs(): WakeyPrefs;
  persist(runs: WakeyRun[]): void;
  broadcast(snapshot: WakeySnapshot): void;
  now(): number;
  /** Runs restored from disk; they stay parked until the first `hello`. */
  initialRuns?: WakeyRun[];
  log?(line: string): void;
}

export interface WakeyCore {
  toggle(opts: WakeyToggleOpts): void;
  stopBySession(sessionId: string): void;
  dismiss(runId: string): void;
  hello(sessions: WakeyHelloSession[]): void;
  setProjectDefault(projectId: string, direction: string): void;
  setBoardContext(projectId: string, summary: string): void;
  onHookStatus(sessionId: string, status: string): void;
  onCliSessionId(sessionId: string, cliSessionId: string): void;
  onPtyData(sessionId: string, chunk: string): void;
  tickWatchdog(): void;
  tickFastpath(): void;
  snapshot(): WakeySnapshot;
  dispose(): Promise<void>;
}

interface PtyState { tail: string; lastOutputAt: number; lastChangeAt: number }
interface BrainEntry { brain: WakeyBrain; lastUsedAt: number }

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function errMessage(err: unknown): string {
  return (err as { message?: string } | undefined)?.message ?? String(err);
}

/**
 * A run read back from disk can be anything (hand-edited, half-written, from an
 * older shape). Normalize the fields the loop mutates so one bad object cannot
 * crash supervision, and park mid-cycle phases back at idle — a `thinking` /
 * `typing` phase persisted through a crash would otherwise freeze the watchdog,
 * which only fires for idle runs.
 */
function reviveRun(raw: WakeyRun): WakeyRun {
  const run = { ...raw };
  run.history = Array.isArray(run.history) ? run.history : [];
  run.supervisionTimestamps = Array.isArray(run.supervisionTimestamps) ? run.supervisionTimestamps : [];
  run.iterations = Number.isFinite(run.iterations) ? run.iterations : 0;
  run.transcriptOffset = Number.isFinite(run.transcriptOffset) ? run.transcriptOffset : 0;
  run.consecutiveErrors = Number.isFinite(run.consecutiveErrors) ? run.consecutiveErrors : 0;
  run.startedAt = Number.isFinite(run.startedAt) ? run.startedAt : Date.now();
  if (run.phase === 'thinking' || run.phase === 'typing') run.phase = 'idle';
  return run;
}

export function createWakeyCore(deps: WakeyCoreDeps): WakeyCore {
  const log = deps.log ?? (() => {});
  const runs: WakeyRun[] = (deps.initialRuns ?? []).filter((r) => r && r.runId).map(reviveRun);
  const projectDefaults = new Map<string, string>();
  const boards = new Map<string, string>();
  /** Board text already handed to a run's brain — resent only when it changes. */
  const boardSentHash = new Map<string, string>();
  const inFlight = new Set<string>();
  /** A trigger that arrived mid-cycle: run exactly one more cycle when this one lands. */
  const pending = new Set<string>();
  const cooldownUntil = new Map<string, number>();
  const fastpathUntil = new Map<string, number>();
  const lastHookEventAt = new Map<string, number>();
  const lastSupervisionAt = new Map<string, number>();
  const ptyState = new Map<string, PtyState>();
  const brains = new Map<string, BrainEntry>();
  /** Runs that ever had a brain, so a replacement is logged as a restart. */
  const hadBrain = new Set<string>();
  /**
   * Runs that must not be steered yet: `Infinity` = restored from disk, waiting
   * for the first `hello`; a timestamp = armed grace period, orphaned when a
   * tick observes it has passed.
   */
  const orphanDeadline = new Map<string, number>();
  const answeredHash = new Map<string, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let helloSeen = false;
  let disposed = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  for (const run of runs) if (isActive(run)) orphanDeadline.set(run.runId, Number.POSITIVE_INFINITY);

  function later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, ms);
    timers.add(t);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => later(ms, resolve));
  }

  function snapshot(): WakeySnapshot {
    return {
      runs: runs.filter((r) => !r.dismissed),
      projectDefaults: Object.fromEntries(projectDefaults),
    };
  }

  /** Debounced fan-out: 100ms to the windows, 500ms to disk. */
  function changed(): void {
    if (disposed) return;
    if (!broadcastTimer) {
      broadcastTimer = setTimeout(() => { broadcastTimer = null; if (!disposed) deps.broadcast(snapshot()); }, BROADCAST_DEBOUNCE_MS);
    }
    if (!persistTimer) {
      persistTimer = setTimeout(() => { persistTimer = null; if (!disposed) deps.persist(runs); }, PERSIST_DEBOUNCE_MS);
    }
  }

  function activeRunForSession(sessionId: string): WakeyRun | undefined {
    return runs.find((r) => r.sessionId === sessionId && isActive(r));
  }

  /**
   * May we still act on this run — write into its session, record against it?
   * Anything that survives an async boundary (a brain turn, the 1.5s echo poll,
   * a fallback spawn) has to ask again: the user may have stopped the run,
   * dismissed it (which also removes it from `runs`), or quit the app since.
   */
  function stillLive(run: WakeyRun): boolean {
    return !disposed && isActive(run) && runs.includes(run);
  }

  function forgetRun(runId: string): void {
    killBrain(runId);
    hadBrain.delete(runId);
    inFlight.delete(runId);
    pending.delete(runId);
    cooldownUntil.delete(runId);
    fastpathUntil.delete(runId);
    lastHookEventAt.delete(runId);
    lastSupervisionAt.delete(runId);
    orphanDeadline.delete(runId);
    boardSentHash.delete(runId);
  }

  // --- brains ---------------------------------------------------------------

  function killBrain(runId: string): void {
    const entry = brains.get(runId);
    if (!entry) return;
    brains.delete(runId);
    void entry.brain.dispose().catch(() => {});
  }

  /**
   * The run's persistent brain, created lazily. A brain past the turn cap is
   * recycled here (fresh session, transcript re-read from 0) — so this must run
   * before the cycle context is built.
   */
  function getBrain(run: WakeyRun, prefs: WakeyPrefs): WakeyBrain {
    let entry = brains.get(run.runId);
    if (entry && entry.brain.turns() >= BRAIN_TURN_CAP) {
      killBrain(run.runId);
      entry = undefined;
    }
    if (entry) {
      entry.lastUsedAt = deps.now();
      return entry.brain;
    }
    const replacing = hadBrain.has(run.runId);
    // A fresh brain has no memory of the session: re-read the whole transcript
    // and re-send the board on the next context build.
    run.transcriptOffset = 0;
    boardSentHash.delete(run.runId);
    const brain = deps.brainFactory(prefs.wakeyModel, prefs.wakeySystemPrompt);
    brains.set(run.runId, { brain, lastUsedAt: deps.now() });
    hadBrain.add(run.runId);
    if (replacing) recordBrainRestart(run, 'supervisor brain restarted — re-reading full transcript', deps.now());
    return brain;
  }

  function sweepBrains(now: number): void {
    for (const [runId, entry] of Array.from(brains)) {
      const run = runs.find((r) => r.runId === runId);
      const idleSince = Math.max(lastSupervisionAt.get(runId) ?? 0, entry.lastUsedAt);
      if (!run || !isActive(run) || now - idleSince >= BRAIN_IDLE_MS) killBrain(runId);
    }
  }

  /**
   * Every CLI session feeds the tail (a dialog can appear long before Wakey is
   * toggled on for it), so drop the buffers of long-dead sessions that no run
   * points at rather than growing one 4KB string per session forever.
   */
  function sweepPtyState(now: number): void {
    for (const [sessionId, st] of Array.from(ptyState)) {
      if (now - st.lastOutputAt < PTY_STATE_TTL_MS) continue;
      if (runs.some((r) => r.sessionId === sessionId && !r.dismissed)) continue;
      ptyState.delete(sessionId);
      answeredHash.delete(sessionId);
    }
  }

  // --- screen tracking + dialog fast-path -----------------------------------

  function onPtyData(sessionId: string, chunk: string): void {
    if (disposed || !chunk) return;
    const now = deps.now();
    const prev = ptyState.get(sessionId);
    const tail = ((prev?.tail ?? '') + chunk).slice(-TAIL_CAP);
    ptyState.set(sessionId, {
      tail,
      lastOutputAt: now,
      // Pure repaints that leave the tail identical must not reset stability.
      lastChangeAt: prev && prev.tail === tail ? prev.lastChangeAt : now,
    });
  }

  function screenStable(sessionId: string): boolean {
    const st = ptyState.get(sessionId);
    return !!st && deps.now() - st.lastChangeAt >= SCREEN_STABLE_MS;
  }

  /**
   * Answer a settled dialog directly, bypassing the brain. Returns true when a
   * key was sent. Dedupes on the screen hash so one dialog is answered once,
   * however many ticks or hook events see it.
   */
  function tryFastpath(run: WakeyRun): boolean {
    // A restored run that `hello` has not re-bound yet points at a sessionId
    // that may belong to nobody (or to somebody else). Same gate superviseRun
    // has — a replayed `input` hook must not get to type keys before the
    // binding is confirmed.
    if (orphanDeadline.has(run.runId)) return false;
    const st = ptyState.get(run.sessionId);
    if (!st) return false;
    const now = deps.now();
    if (now < (fastpathUntil.get(run.runId) ?? 0)) return false;
    if (now - st.lastChangeAt < SCREEN_STABLE_MS) return false;
    const match = deps.matchDialog(st.tail);
    if (!match) return false;
    const h = sha1(st.tail);
    if (answeredHash.get(run.sessionId) === h) return false;
    answeredHash.set(run.sessionId, h);
    deps.writePty(run.sessionId, match.keys);
    recordFastpath(run, match.label, now);
    fastpathUntil.set(run.runId, now + FASTPATH_COOLDOWN_MS);
    cooldownUntil.set(run.runId, Math.max(cooldownUntil.get(run.runId) ?? 0, now + FASTPATH_COOLDOWN_MS));
    log(`[wakey] fast-path: ${match.label} (${run.sessionId})`);
    changed();
    return true;
  }

  // --- the supervision cycle ------------------------------------------------

  function boardFor(projectId: string): string | undefined {
    return boards.get(projectId) || undefined;
  }

  /**
   * One turn's worth of context for the persistent brain: only what changed
   * since its last turn. The transcript delta is the bulk of it; the direction
   * is repeated every turn (it is the run's whole point) and the board only
   * when its text changed.
   */
  function buildCycleContext(run: WakeyRun): string {
    const delta = deps.readDelta(run.projectPath, run.cliSessionId ?? '', run.transcriptOffset);
    run.transcriptOffset = delta.newOffset;
    const parts: string[] = [];
    if (run.direction) parts.push(`USER DIRECTION (highest priority): ${run.direction}`);
    const board = boardFor(run.projectId);
    if (board) {
      const h = sha1(board);
      if (boardSentHash.get(run.runId) !== h) {
        boardSentHash.set(run.runId, h);
        parts.push(`KANBAN BOARD (project priorities):\n${board}`);
      }
    }
    const recent = recentSteers(run, 3);
    if (recent.length) {
      parts.push(
        'YOUR RECENT STEERS (newest first) — do NOT repeat or trivially rephrase these:\n' +
        recent.map((p, i) => `${i + 1}. ${p}`).join('\n'),
      );
    }
    parts.push(delta.full
      ? `SESSION TRANSCRIPT (full context):\n${delta.text || '(no transcript yet — the session is fresh)'}`
      : `NEW TRANSCRIPT SINCE YOUR LAST TURN:\n${delta.text || '(nothing new — the session has been quiet since your last steer)'}`);
    parts.push('Reply with JUST the literal text the user should type next, or STOP if the goal is genuinely complete.');
    return parts.join('\n\n');
  }

  /**
   * The typing phase is the run's visible state while a steer is on its way in
   * (the spec's `(>.>)(<.<)` eyes), so it lasts as long as the write actually
   * does: text → Enter → echo verification → at most one retype. Bounded at
   * ~3.3s while the process lives, and normalized back to idle by `reviveRun` /
   * `dispose` if the app dies mid-write — the watchdog only fires on idle runs,
   * so a stranded `typing` would freeze the run forever.
   */
  function settleTyping(run: WakeyRun): void {
    if (!stillLive(run) || run.phase !== 'typing') return;
    run.phase = 'idle';
    changed();
  }

  /**
   * Type a steer into the session. The text lands synchronously; Enter and the
   * echo check run on their own timers so a 1.5s verification (plus a retry)
   * never holds the supervision cycle hostage. The steer is recorded by the
   * caller as soon as the text is written: from the run's point of view it has
   * been attempted, and a missed echo shows up as its own error history entry.
   */
  function typeSteer(run: WakeyRun, text: string): void {
    run.phase = 'typing';
    changed();
    const sessionId = run.sessionId;
    // Nothing to verify against on a session we have never seen output from.
    const verifiable = ptyState.has(sessionId);
    deps.writePty(sessionId, text);
    pressEnter(run, sessionId, text, verifiable, 0);
  }

  function pressEnter(run: WakeyRun, sessionId: string, text: string, verifiable: boolean, attempt: number): void {
    later(ENTER_DELAY_MS, () => {
      // Stopped or dismissed inside the 80ms gap: leave the session alone. The
      // text sits unsubmitted in the input box, which is what the user asked for.
      if (!stillLive(run)) return;
      deps.writePty(sessionId, '\r');
      log(`[wakey] typed steer into ${sessionId}: ${JSON.stringify(text.slice(0, 80))} + <CR>`);
      if (!verifiable) { settleTyping(run); return; }
      void verifyEcho(run, sessionId, text, attempt)
        .catch(() => true)
        .then((done) => { if (done) settleTyping(run); });
    });
  }

  /** Resolves true when this write is over, false when a retype is in flight. */
  async function verifyEcho(run: WakeyRun, sessionId: string, text: string, attempt: number): Promise<boolean> {
    const probe = stripAnsi(text).slice(0, ECHO_PREFIX_CHARS);
    if (!probe) return true;
    const deadline = Date.now() + ECHO_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!stillLive(run)) return true;
      if (stripAnsi(ptyState.get(sessionId)?.tail ?? '').includes(probe)) return true;
      await sleep(ECHO_POLL_MS);
    }
    // The wait is 1.5s of someone else's time: a stop or dismiss that landed in
    // it means neither a retype nor an error entry belongs to this run any more.
    if (!stillLive(run)) return true;
    if (attempt === 0) {
      log(`[wakey] steer not echoed by ${sessionId} — retyping once`);
      deps.writePty(sessionId, text);
      pressEnter(run, sessionId, text, true, 1);
      return false;
    }
    recordError(run, `typed steer never echoed back: ${JSON.stringify(probe)}`, deps.now());
    changed();
    return true;
  }

  /** Throw a steer away: back to idle, and hold off before asking again. */
  function rejectSteer(run: WakeyRun): void {
    run.phase = 'idle';
    const until = deps.now() + REJECTED_STEER_COOLDOWN_MS;
    cooldownUntil.set(run.runId, Math.max(cooldownUntil.get(run.runId) ?? 0, until));
    changed();
  }

  async function superviseRun(run: WakeyRun, trigger: 'hook' | 'watchdog'): Promise<void> {
    if (disposed || !isActive(run)) return;
    // Restored-but-unbound runs point at a sessionId that may not exist.
    if (orphanDeadline.has(run.runId)) return;
    if (inFlight.has(run.runId)) { pending.add(run.runId); return; }
    if (deps.now() < (cooldownUntil.get(run.runId) ?? 0)) return;

    const prefs = deps.loadPrefs();
    if (run.iterations >= prefs.wakeyMaxIterations) {
      stopRun(run, 'max-iterations', deps.now());
      killBrain(run.runId);
      changed();
      return;
    }
    if (rateCapExceeded(run, deps.now())) {
      stopRun(run, 'rate-cap', deps.now());
      killBrain(run.runId);
      changed();
      return;
    }

    inFlight.add(run.runId);
    const cycleStart = deps.now();
    lastSupervisionAt.set(run.runId, cycleStart);
    // Every cycle counts against the rolling cap, not just the ones that end in
    // a typed steer: a brain stuck on filler or repeats costs the same turns and
    // must not be able to chain them uncapped.
    recordSupervision(run, cycleStart);
    run.phase = 'thinking';
    changed();
    try {
      let text: string;
      try {
        const brain = getBrain(run, prefs);
        text = await brain.steer(buildCycleContext(run));
      } catch (err) {
        // A rejected steer means that brain instance is dead (see WakeyBrain.steer):
        // drop it, rewind the transcript, and let the next cycle build a fresh one.
        recordError(run, `brain: ${errMessage(err)}`, deps.now());
        killBrain(run.runId);
        run.transcriptOffset = 0;
        if (run.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          // Never relabel a run the user already stopped as an error stop.
          if (isActive(run)) stopRun(run, 'errors', deps.now());
          changed();
          return;
        }
        // The fallback is a whole `claude` process. Don't spawn one for a cycle
        // the user cancelled while the brain was failing — its answer would be
        // discarded on the `stillLive` check below anyway.
        if (!stillLive(run)) { changed(); return; }
        // Degrade, don't die: a one-shot spawn still lands this cycle's steer.
        log(`[wakey] brain unavailable (${trigger} cycle) — falling back to one-shot supervision`);
        const full = deps.readDelta(run.projectPath, run.cliSessionId ?? '', 0);
        text = await deps.superviseFallback({
          cwd: run.projectPath,
          sessionId: run.sessionId,
          systemPrompt: prefs.wakeySystemPrompt,
          userPrompt: buildUserPrompt({
            transcript: full.text || '(no transcript)',
            direction: run.direction ?? undefined,
            recentPrompts: recentSteers(run, 5),
            boardContext: boardFor(run.projectId),
            cwd: run.projectPath,
          }),
        });
        run.transcriptOffset = full.newOffset;
      }

      // The user can stop or dismiss the run while the brain is thinking; a
      // steer decided before that must not still land in the session.
      if (!stillLive(run)) return;

      const steer = text.trim();
      if (isStopResponse(steer)) {
        stopRun(run, 'goal-complete', deps.now());
        run.lastSteer = steer;
        killBrain(run.runId);
        changed();
        return;
      }
      if (FILLER.test(steer)) {
        log(`[wakey] rejected filler steer ${JSON.stringify(steer)}`);
        rejectSteer(run);
        return;
      }
      if (recentSteers(run, 3).includes(steer)) {
        log(`[wakey] rejected repeated steer ${JSON.stringify(steer.slice(0, 60))}`);
        rejectSteer(run);
        return;
      }

      // `typeSteer` owns the phase from here: it stays `typing` until the write
      // (Enter + echo verification + at most one retype) has settled.
      typeSteer(run, steer);
      recordSteer(run, steer, deps.now());
      cooldownUntil.set(run.runId, deps.now() + STEER_COOLDOWN_MS);
      changed();
    } catch (err) {
      // Anything else that blew up mid-cycle (fallback spawn, write) counts as
      // one error against the same cap.
      recordError(run, `cycle: ${errMessage(err)}`, deps.now());
      if (run.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) stopRun(run, 'errors', deps.now());
      else run.phase = 'idle';
      changed();
    } finally {
      inFlight.delete(run.runId);
      // Exactly one catch-up cycle for triggers that arrived while we were busy.
      if (pending.delete(run.runId) && !disposed) void superviseRun(run, 'hook');
    }
  }

  // --- public surface -------------------------------------------------------

  const core: WakeyCore = {
    toggle(opts: WakeyToggleOpts): void {
      if (disposed) return;
      const existing = activeRunForSession(opts.sessionId);
      if (existing) {
        stopRun(existing, 'user', deps.now());
        killBrain(existing.runId);
        log(`[wakey] toggled OFF for ${opts.sessionId}`);
        changed();
        return;
      }
      if (opts.boardContext) boards.set(opts.projectId, opts.boardContext);
      const direction = (opts.direction ?? '').trim() || (projectDefaults.get(opts.projectId) ?? '').trim() || null;
      const run = createRun({
        sessionId: opts.sessionId,
        cliSessionId: opts.cliSessionId,
        projectPath: opts.projectPath,
        projectId: opts.projectId,
        direction,
        now: deps.now(),
      });
      runs.push(run);
      log(`[wakey] toggled ON for ${opts.sessionId} (run ${run.runId})`);
      changed();
      // Wakey drives the session — it does not wait for the first hook event.
      void superviseRun(run, 'hook');
    },

    stopBySession(sessionId: string): void {
      const run = activeRunForSession(sessionId);
      if (!run) return;
      stopRun(run, 'user', deps.now());
      killBrain(run.runId);
      changed();
    },

    dismiss(runId: string): void {
      const i = runs.findIndex((r) => r.runId === runId);
      if (i === -1) return;
      // Flag before removing: an in-flight cycle still holds this object and
      // checks `isActive` before it types anything.
      runs[i].dismissed = true;
      runs.splice(i, 1);
      forgetRun(runId);
      changed();
    },

    /**
     * A window announcing its live sessions. Persisted runs rebind to whichever
     * session carries the same CLI session id; anything still unmatched after
     * the first hello gets a grace period before it is called orphaned.
     */
    hello(sessions: WakeyHelloSession[]): void {
      if (disposed) return;
      const list = Array.isArray(sessions) ? sessions : [];
      for (const run of runs) {
        if (!isActive(run)) continue;
        const match = run.cliSessionId
          ? list.find((s) => s.cliSessionId && s.cliSessionId === run.cliSessionId)
          : list.find((s) => s.sessionId === run.sessionId);
        if (match) {
          if (match.sessionId !== run.sessionId) {
            log(`[wakey] rebound run ${run.runId}: ${run.sessionId} → ${match.sessionId}`);
            run.sessionId = match.sessionId;
          }
          orphanDeadline.delete(run.runId);
        } else if (!helloSeen) {
          orphanDeadline.set(run.runId, deps.now() + ORPHAN_GRACE_MS);
        }
      }
      helloSeen = true;
      changed();
    },

    setProjectDefault(projectId: string, direction: string): void {
      const trimmed = (direction ?? '').trim();
      if (trimmed) projectDefaults.set(projectId, trimmed);
      else projectDefaults.delete(projectId);
      changed();
    },

    setBoardContext(projectId: string, summary: string): void {
      const trimmed = (summary ?? '').trim();
      if (trimmed) boards.set(projectId, trimmed);
      else boards.delete(projectId);
    },

    onHookStatus(sessionId: string, status: string): void {
      if (disposed) return;
      const run = activeRunForSession(sessionId);
      if (!run) return;
      lastHookEventAt.set(run.runId, deps.now());
      if (status === 'completed') {
        void superviseRun(run, 'hook');
        return;
      }
      if (status !== 'input') return;
      // A prompt is waiting: a keypress is cheaper and faster than a brain turn.
      if (tryFastpath(run)) return;
      if (!screenStable(sessionId)) {
        // The dialog may still be painting — look once more when it has settled.
        later(SCREEN_STABLE_MS, () => {
          if (!isActive(run) || tryFastpath(run)) return;
          void superviseRun(run, 'hook');
        });
        return;
      }
      void superviseRun(run, 'hook');
    },

    /**
     * The session's `.sessionid` changed (a `/clear` starts a new CLI session).
     * Only the *active* run may be rebound: stopped runs stay in `runs` forever
     * and are older, so a plain by-session lookup would hand the new id to a
     * dead run and leave the live one reading a transcript that never grows
     * again. With no active run there is nothing to rebind — a stopped or
     * orphaned run's `cliSessionId` is a record of what it supervised, and its
     * offset will never be read again, so both are left untouched.
     */
    onCliSessionId(sessionId: string, cliSessionId: string): void {
      if (disposed || !cliSessionId) return;
      const run = activeRunForSession(sessionId);
      if (!run || run.cliSessionId === cliSessionId) return;
      run.cliSessionId = cliSessionId;
      // Different transcript file — the old offset means nothing in it.
      run.transcriptOffset = 0;
      changed();
    },

    onPtyData,

    tickWatchdog(): void {
      if (disposed) return;
      const now = deps.now();
      for (const run of runs) {
        const deadline = orphanDeadline.get(run.runId);
        if (deadline === undefined || !isActive(run) || now < deadline) continue;
        run.phase = 'orphaned';
        orphanDeadline.delete(run.runId);
        forgetRun(run.runId);
        log(`[wakey] run ${run.runId} orphaned — its session never came back`);
        changed();
      }
      sweepBrains(now);
      sweepPtyState(now);
      const prefs = deps.loadPrefs();
      for (const run of runs) {
        if (!isActive(run) || orphanDeadline.has(run.runId)) continue;
        const st = ptyState.get(run.sessionId);
        const force = shouldForceSupervision({
          phase: run.phase,
          stopped: !!run.stop,
          cooldownUntil: cooldownUntil.get(run.runId) ?? 0,
          lastSupervisionAt: lastSupervisionAt.get(run.runId) ?? 0,
          lastHookEventAt: lastHookEventAt.get(run.runId) ?? 0,
          lastPtyOutputAt: st?.lastOutputAt ?? 0,
          startedAt: run.startedAt,
          now,
          quietMinutes: prefs.wakeyWatchdogMinutes,
        });
        if (force) {
          log(`[wakey] watchdog forcing supervision for ${run.sessionId}`);
          void superviseRun(run, 'watchdog');
        }
      }
    },

    tickFastpath(): void {
      if (disposed) return;
      for (const run of runs) {
        if (!isActive(run) || run.phase === 'typing' || orphanDeadline.has(run.runId)) continue;
        tryFastpath(run);
      }
    },

    snapshot,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      for (const t of timers) clearTimeout(t);
      timers.clear();
      // Active runs are meant to survive a restart; a mid-cycle phase is not.
      for (const run of runs) if (isActive(run) && run.phase !== 'idle') run.phase = 'idle';
      try { deps.persist(runs); } catch { /* best effort on the way out */ }
      const all = Array.from(brains.values());
      brains.clear();
      await Promise.all(all.map((e) => e.brain.dispose().catch(() => {})));
    },
  };

  return core;
}

// --- module-level singleton (the app's one core) -----------------------------

let coreInstance: WakeyCore | null = null;
let intervals: Array<ReturnType<typeof setInterval>> = [];
let unsubscribes: Array<() => void> = [];

function realPrefsLoader(): () => WakeyPrefs {
  let cache: { at: number; value: WakeyPrefs } | null = null;
  return () => {
    const now = Date.now();
    if (cache && now - cache.at < PREFS_CACHE_MS) return cache.value;
    let prefs: Partial<WakeyPrefs> = {};
    try { prefs = (loadState().preferences ?? {}) as Partial<WakeyPrefs>; } catch { prefs = {}; }
    const value: WakeyPrefs = {
      wakeyMaxIterations: prefs.wakeyMaxIterations ?? DEFAULT_PREFS.wakeyMaxIterations,
      wakeySystemPrompt: (prefs.wakeySystemPrompt ?? '').trim() || DEFAULT_PREFS.wakeySystemPrompt,
      wakeyModel: (prefs.wakeyModel ?? '').trim() || DEFAULT_PREFS.wakeyModel,
      wakeyWatchdogMinutes: prefs.wakeyWatchdogMinutes ?? DEFAULT_PREFS.wakeyWatchdogMinutes,
    };
    cache = { at: now, value };
    return value;
  };
}

/** Build the real core, register its IPC surface, and start its timers. */
export function initWakeyCore(ipcMain: IpcMain): WakeyCore {
  if (coreInstance) return coreInstance;
  const core = createWakeyCore({
    writePty: (sessionId, data) => writePty(sessionId, data),
    readDelta: (cwd, cli, offset) => readTranscriptDelta(cwd, cli, offset),
    matchDialog,
    brainFactory: (model, systemPrompt) => {
      // Same binary the one-shot fallback runs: the user's own logged-in
      // `claude`. Only an absolute hit is used; otherwise the SDK's bundled CLI.
      const found = resolveBinary('claude', { path: null });
      return createWakeyBrain({
        queryFn: sdkQuery, model, systemPrompt, log: (line) => console.log(line),
        claudePath: path.isAbsolute(found) ? found : undefined,
      });
    },
    superviseFallback: (opts) => superviseOnce(opts),
    loadPrefs: realPrefsLoader(),
    persist: (runs) => {
      try { saveRuns(RUNS_FILE, runs); } catch (err) { console.warn(`[wakey] persist failed: ${errMessage(err)}`); }
    },
    broadcast: (snap) => broadcastToAllWindows('wakey:state', snap),
    now: Date.now,
    initialRuns: loadRuns(RUNS_FILE),
    log: (line) => console.log(line),
  });
  coreInstance = core;

  ipcMain.handle('wakey:toggle', (_e, opts: WakeyToggleOpts) => core.toggle(opts));
  ipcMain.handle('wakey:stop', (_e, p: { sessionId: string }) => core.stopBySession(p.sessionId));
  ipcMain.handle('wakey:dismiss', (_e, p: { runId: string }) => core.dismiss(p.runId));
  ipcMain.handle('wakey:hello', (_e, p: { sessions: WakeyHelloSession[] }) => core.hello(p?.sessions ?? []));
  ipcMain.handle('wakey:set-project-default', (_e, p: { projectId: string; direction: string }) =>
    core.setProjectDefault(p.projectId, p.direction));
  ipcMain.handle('wakey:board-context', (_e, p: { projectId: string; summary: string }) =>
    core.setBoardContext(p.projectId, p.summary));
  ipcMain.handle('wakey:get-state', () => core.snapshot());

  unsubscribes.push(onHookStatusMain((sessionId, status) => core.onHookStatus(sessionId, status)));
  unsubscribes.push(onCliSessionIdMain((sessionId, cliSessionId) => core.onCliSessionId(sessionId, cliSessionId)));

  intervals.push(setInterval(() => core.tickWatchdog(), WATCHDOG_INTERVAL_MS));
  intervals.push(setInterval(() => core.tickFastpath(), FASTPATH_INTERVAL_MS));

  return core;
}

export async function disposeWakeyCore(): Promise<void> {
  for (const i of intervals) clearInterval(i);
  intervals = [];
  for (const u of unsubscribes) { try { u(); } catch { /* already gone */ } }
  unsubscribes = [];
  const core = coreInstance;
  coreInstance = null;
  await core?.dispose();
}

/** PTY tap from ipc-handlers. No-op until the core exists. */
export function wakeyOnPtyData(sessionId: string, chunk: string): void {
  coreInstance?.onPtyData(sessionId, chunk);
}
