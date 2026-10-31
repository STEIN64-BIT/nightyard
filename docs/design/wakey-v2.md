# Wakey v2: Seamless Supervisor

**Date:** 2026-07-28
**Status:** Implemented (`src/main/wakey/`, `src/renderer/state/wakey-state.ts`, `src/renderer/components/wakey-status-panel.ts`)

## Problem

Wakey v1 (the autonomous session supervisor) was not seamless. Observed pains:

1. **Stops/dies silently** — the whole loop lives in renderer memory; a reload,
   window close, or crash kills it with no trace. STOP / max-iterations also
   remove the run from the panel entirely, so returning to the terminal shows
   nothing about what happened.
2. **Slow / misses turns** — the loop fires only on `completed`/`input` hook
   events relayed to the renderer; a missed event stalls the run forever. Each
   supervision is a cold `claude -p` spawn (10–30s, 90s timeout).
3. **Stuck on dialogs** — folder-trust, plan-approval, retry and permission
   prompts each cost a full supervisor round, which sometimes times out.

Plus two UX wishes: an **animated eyes face** (the `(-.-)` glyph, but awake)
showing wakey actively working on a specific project, and a **status panel that
is always there when you come back** to that terminal.

## Decisions (settled in brainstorm)

- Status UI: **fix the floating panel** (not an in-terminal strip) — survives
  stops, renders in all windows, animated eyes.
- Persistence: **auto-resume** — loop moves to the main process, run state
  persists on disk, app restart/reload picks runs back up.
- Dialogs: **fast-path + supervisor** — routine dialogs answered instantly from
  the terminal screen without an LLM call; real questions go to the supervisor.
- Supervisor: **persistent brain** (approach B) — one long-lived Claude Agent
  SDK session per wakey run with delta context, over the fresh-spawn-per-turn
  approach A.
- Scope: **wakey only.** Sleepy v2 is a separate follow-up brainstorm.

## 1. Core loop in the main process

New module `src/main/wakey/wakey-core.ts` owns all runs. The renderer becomes
thin: `wakey:toggle` / `wakey:stop` / `wakey:restart` / `wakey:dismiss` IPC in,
full-state snapshots out via a `wakey:state-changed` broadcast to **all**
windows (`broadcastToAllWindows`, same mechanism as `session:hookStatus`).
`src/renderer/state/wakey-state.ts` shrinks to a mirror of the pushed snapshot
plus the IPC calls; `toggleWakey` callers (header button, graph launch) keep
their signatures.

### Run state & persistence

`~/.nightyard/wakey-runs.json`, written on every state change (debounced):

```ts
interface WakeyRun {
  sessionId: string;          // app session id at creation time
  cliSessionId: string | null;
  projectPath: string;
  projectId: string;
  direction: string | null;
  iterations: number;
  phase: 'idle' | 'thinking' | 'typing' | 'stopped' | 'orphaned';
  lastSteer: string | null;
  history: Array<{ at: number; kind: 'steer' | 'fastpath' | 'error'; text: string }>;
  transcriptOffset: number;   // byte offset into the session JSONL (brain delta)
  stop: { reason: 'goal-complete' | 'max-iterations' | 'errors' | 'user' | 'rate-cap'; at: number } | null;
  supervisionTimestamps: number[]; // rolling window for the rate cap
}
```

**Auto-resume:** on launch, load runs. Active (non-stopped) runs wait for a
restored session whose `cliSessionId` matches; on match, re-arm the loop on the
new session id. If no match within a grace window (~60s after window ready),
the run flips to `orphaned` — visible in the panel with "restart in new
session" / dismiss. Stopped runs load as-is (still visible until dismissed).

### Triggers (three, replacing today's one)

1. **Hook events** — `completed`/`input`, subscribed at the source in main
   (`hook-status.ts` file watcher), no renderer hop. Existing 8s post-type
   cooldown and in-flight guard move over unchanged.
2. **Watchdog** — one 60s interval scans runs: a run that is `idle`, past
   cooldown, with no hook event since its last steer **and** no PTY output for
   `wakeyWatchdogMinutes` (new preference, default 3) gets a forced supervision
   cycle. PTY quietness is judged from a per-session last-output timestamp
   kept by pty-manager (cheap hook on the data event). This catches every
   missed hook event.
3. **Dialog fast-path** — a matcher over the recent PTY output tail (ring
   buffer, last ~4KB per wakey session) recognizes routine blockers and
   answers with direct keystrokes, no LLM call:
   - folder trust ("Do you trust the files in this folder") → yes
   - permission menus (`❯ 1. Yes` style) → `1`/Enter (or `y`)
   - plan approval ("Would you like to proceed") → approve
   - retry-after-API-error prompts → retry
   Debounced ~1.5s of screen stability before answering; each answer is logged
   to `history` as `fastpath`. **Destructive guard:** if the surrounding screen
   text matches destructive patterns (delete, remove, overwrite, force, reset,
   push --force, rm -rf, drop), the fast-path never fires — the `input` hook
   path sends it to the supervisor instead.

### Typing reliability

Keep the split write (`text`, 80ms, `\r`). After writing, verify the text
echoed into the PTY buffer; if not, retry once before giving up and logging an
`error` history entry.

## 2. Persistent supervisor brain

`src/main/wakey/wakey-brain.ts` — one long-lived Claude Agent SDK session per
active run: streaming input `query()`,
`tools: []`, `settingSources: []`, `strictMcpConfig`, subscription CLI auth
with `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` stripped from the child env.
Model: sonnet (new preference `wakeyModel`, default sonnet).

- **First supervision:** full context — transcript tail (last 14 messages /
  8KB, today's parser reused), board summary, direction, steering rules
  (today's system prompt, adapted).
- **Subsequent supervisions:** delta only — new JSONL messages since
  `transcriptOffset` (offset advanced after each read), board summary only
  when its hash changed, one-line direction reminder. The brain remembers its
  own strategy across iterations, so steers get both faster and smarter.
- **Lifecycle:** lazy start on first supervision; killed after 30 min with no
  supervision; killed on run stop and app quit. On crash or recycle (near the
  SDK turn cap ~40 turns), restart transparently with a fresh full-context
  read. Restarts are invisible in the panel except a `history` entry.
- **Fallback:** if the SDK session cannot spawn, that cycle runs today's
  one-shot `superviseOnce` (`wakey-runner.ts` stays for this) — wakey degrades
  to slow instead of dead.
- Steering rules unchanged: no bare filler (rejected + logged), STOP semantics
  via `isStopResponse`, direction bias, recent-steers dedupe (reject a steer
  identical to one of the last 3 in `history`).

## 3. Panel + eyes

The floating bottom-right panel is rebuilt to render purely from the pushed
main snapshot (`wakey-status-panel.ts` rewrite, same mount point):

- **Nothing vanishes silently.** Stopped runs stay as rows —
  `(-.-) stopped · goal complete · 12 iters` — with **[restart]** (same
  session if alive, else new session in that project) and **[dismiss]**.
  Errors show reason + last error line. Orphaned runs (post-restart, session
  not restored) show the same treatment.
- **Every window** mounts the panel (detached tear-off windows included),
  scoped to sessions visible in that window, `+N elsewhere` footer preserved.
  Collapsed-pill behavior and the per-project default-direction field are
  preserved as-is.
- Expanded rows show the last steer (as today) plus the last few `history`
  entries (fast-path answers, errors) on demand.

### Eyes animation

A tiny shared `wakey-eyes.ts` helper: one global ticker (500ms) drives every
mounted face; frames are plain text swaps keyed by phase:

| phase    | frames                                      |
|----------|---------------------------------------------|
| thinking | `(o.o) (o.-) (o.o) (-.o) (0.0)` scan-blink  |
| typing   | `(>.>) (<.<)` shifty                         |
| idle     | `(o.o)` with a slow `(-.-)` blink every ~4s |
| stopped  | `(-.-) zZz` (matches the sleepy glyph)      |
| orphaned | `(o.O)`                                     |
| error    | `(x.x)`                                     |

Faces appear: per panel row, in the collapsed pill, and in the **tab badge**
(`tab-wakey-badge` becomes `(o.o) 7` and animates) — so the tab bar itself
shows which project wakey is working on right now.

## 4. Safety, cost & error handling

- Existing `wakeyMaxIterations` cap (default 50) honored in main.
- **Rate cap:** max 30 supervisions per rolling hour per run → auto-stop with
  reason `rate-cap` shown in the panel.
- **Error stop:** 3 consecutive failed supervisions → auto-stop with reason
  `errors` (no infinite retry loops).
- App quit kills all brains cleanly and flushes state; resume only re-arms
  persisted runs, never invents new ones.
- Fast-path never fires on destructive-pattern screens (see §1).
- All stops write reason + timestamp; the panel is the single source of truth
  for "what happened while I was away".

## Non-goals

- Sleepy v2 (separate follow-up).
- Supervisor tool use (brain stays `tools: []`).
- In-terminal status strip (explicitly not chosen).

## Testing

Unit (brain + SDK mocked):
- Run store: persist/restore round-trip, cliSessionId re-attach matching,
  orphan flip after grace window, dismiss/restart transitions.
- Watchdog decision: pure function `(run, now, lastPtyOutputAt) → fire?`
  covering cooldown, phase, and quiet-window edges.
- Dialog matcher: fixture terminal buffers for each recognized dialog →
  correct keystrokes; destructive-pattern fixtures → never fires.
- Transcript delta reader: offset advance, truncated/rotated file fallback to
  full read.
- Eyes cycler: phase → frame sequences, shared-ticker registration/cleanup.
- Steer hygiene: filler rejection, STOP handling, last-3 dedupe (existing
  tests migrated).

Manual live checklist:
- Reload the window mid-run → run resumes, panel row intact.
- Quit + relaunch app → run re-arms on the restored session.
- Trigger a folder-trust dialog → answered in <2s, `fastpath` history entry.
- Let a run STOP → row stays with reason; [restart] works; [dismiss] clears.
- Detach a tab to its own window → panel appears there with that run.
- Eyes animate per phase in panel, pill, and tab badge.
