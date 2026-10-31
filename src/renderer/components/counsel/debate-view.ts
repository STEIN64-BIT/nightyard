import type { CounselResult, CounselSeat } from '../../../shared/types.js';
import { clearActiveCounsel, stopCounsel, type ActiveCounsel } from '../../counsel-store.js';
import { createDeltaCoalescer, isNearBottom } from './stream-helpers.js';
import { renderVerdictCard } from './verdict-card.js';

type DebateSource = ActiveCounsel | CounselResult;

function isActiveSource(source: DebateSource): source is ActiveCounsel {
  return 'status' in source;
}

interface RenderTurn {
  turnId: string;
  seat: CounselSeat;
  round: number;
  text: string;
  done: boolean;
}

/** Normalizes both source shapes to a common turn list. History turns have no
 * `done` flag (there's no such thing as "in progress" once persisted) — they
 * count as done so the sync logic renders them statically in one pass. */
function getTurns(source: DebateSource): RenderTurn[] {
  if (isActiveSource(source)) return source.turns;
  return source.turns.map((t) => ({ ...t, done: true }));
}

function getVerdict(source: DebateSource) {
  return isActiveSource(source) ? source.verdict : (source.verdict ?? null);
}

interface TurnRenderState {
  /** `Text` node in the real DOM; a plain `{ textContent }` object in tests
   * without a DOM (matches what `document.createTextNode` returns there). */
  textNode: { textContent: string };
  coalescer: ReturnType<typeof createDeltaCoalescer>;
  /** How many chars of the turn's accumulated text we've already applied —
   * lets a later sync push only the new slice instead of the whole text. */
  renderedLength: number;
  /** Once true, `turn.text` has been written as the canonical final value
   * and this turn is never touched again (turn-end already happened). */
  finalized: boolean;
}

interface DebateMount {
  counselId: string;
  isActive: boolean;
  container: HTMLElement;
  statusEl: HTMLElement | null;
  stopBtn: HTMLButtonElement | null;
  turnRenders: Map<string, TurnRenderState>;
  renderedTurnCount: number;
  renderedNoteCount: number;
  verdictRendered: boolean;
  /** Guards the one-time "New counsel" affordance appended when a live
   * debate reaches status 'done' (see the `renderDebate` doc comment). */
  doneHandled: boolean;
  /** Read-only (CounselResult) source only: returns to the start view.
   * CounselResult carries no projectId, so debate-view itself has nothing
   * to route to — the caller supplies this. */
  onBack: (() => void) | undefined;
}

const mounts = new WeakMap<HTMLElement, DebateMount>();

/**
 * Renders one project's Counsel debate — live (streaming, `ActiveCounsel`)
 * or read-only (a finished `CounselResult` picked from history) — into
 * `root` as a single vertical thread.
 *
 * Called on *every* counsel-store notification while a debate is live
 * (counsel-view.ts's router re-invokes this on each event, including every
 * `turn-delta`), so this function must never rebuild the transcript from
 * scratch on a hot path. It keeps a per-root mount (turn/note/verdict
 * counts + a turnId → {textNode, coalescer} map) in a WeakMap and diffs the
 * incoming source against that recorded state on each call:
 *   - same debate, same mode (live/read-only): only the NEW turns/notes/
 *     verdict since last call get appended, and in-progress turns get their
 *     new text *appended* (rAF-coalesced) rather than re-rendered.
 *   - first mount, or the counselId/mode changed (new debate, or switching
 *     into a different history entry, or live→read-only): full rebuild —
 *     `root` is cleared and every turn/note/verdict present at that moment
 *     renders in one pass (this also naturally handles "catch-up" mounts,
 *     e.g. the user switches to the Counsel tab mid-debate).
 *
 * `onBack` is only meaningful for a `CounselResult` source — it's what the
 * read-only view's "New counsel" button calls to return to the start view.
 * The live-source "New counsel" affordance (once status reaches 'done')
 * instead calls `clearActiveCounsel()` directly, exactly as the Task 6 stub
 * did — nothing else ever nulls counsel-store's singleton `active`, so
 * without this the router would show this view forever for that project.
 */
export function renderDebate(root: HTMLElement, source: DebateSource, onBack?: () => void): void {
  const isActive = isActiveSource(source);
  const existing = mounts.get(root);

  let mount: DebateMount;
  if (!existing || existing.counselId !== source.counselId || existing.isActive !== isActive) {
    mount = createMount(root, source, isActive, onBack);
    mounts.set(root, mount);
  } else {
    mount = existing;
    if (onBack) mount.onBack = onBack;
  }

  syncTurns(mount, source);
  syncModeratorNotes(mount, source);
  syncVerdict(mount, source);
  syncStatus(mount, source);
}

function createMount(root: HTMLElement, source: DebateSource, isActive: boolean, onBack: (() => void) | undefined): DebateMount {
  root.innerHTML = '';

  const mount: DebateMount = {
    counselId: source.counselId,
    isActive,
    container: document.createElement('div'),
    statusEl: null,
    stopBtn: null,
    turnRenders: new Map(),
    renderedTurnCount: 0,
    renderedNoteCount: 0,
    verdictRendered: false,
    doneHandled: false,
    onBack,
  };

  mount.container.className = 'counsel-thread';
  root.appendChild(mount.container);

  if (isActive) {
    const footer = document.createElement('div');
    footer.className = 'counsel-debate-footer';

    mount.statusEl = document.createElement('div');
    mount.statusEl.className = 'counsel-status';
    footer.appendChild(mount.statusEl);

    mount.stopBtn = document.createElement('button');
    mount.stopBtn.type = 'button';
    mount.stopBtn.className = 'counsel-btn counsel-stop-btn';
    mount.stopBtn.textContent = 'Stop';
    mount.stopBtn.addEventListener('click', () => {
      if (!mount.stopBtn) return;
      mount.stopBtn.disabled = true;
      mount.stopBtn.textContent = 'Stopping…';
      // Per spec, stopping still lets the moderator/adjudicator run so a
      // verdict is produced — this view keeps streaming until 'done'.
      void stopCounsel();
    });
    footer.appendChild(mount.stopBtn);

    root.appendChild(footer);
  } else {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'counsel-btn counsel-btn-primary';
    backBtn.textContent = 'New counsel';
    backBtn.addEventListener('click', () => {
      mount.onBack?.();
    });
    root.appendChild(backBtn);
  }

  return mount;
}

function syncTurns(mount: DebateMount, source: DebateSource): void {
  const turns = getTurns(source);
  const seats = source.seats;

  // Structural: append a bubble for each turn we haven't seen before.
  for (let i = mount.renderedTurnCount; i < turns.length; i++) {
    const turn = turns[i];
    const seatConfig = seats[turn.seat];

    const bubble = document.createElement('div');
    bubble.className = `counsel-bubble counsel-seat-${turn.seat.toLowerCase()}`;

    const header = document.createElement('div');
    header.className = 'counsel-bubble-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'counsel-bubble-name';
    nameEl.textContent = seatConfig.memberName;
    header.appendChild(nameEl);

    const roleEl = document.createElement('span');
    roleEl.className = 'counsel-bubble-role';
    roleEl.textContent = seatConfig.memberRole;
    header.appendChild(roleEl);

    bubble.appendChild(header);

    const textEl = document.createElement('div');
    textEl.className = 'counsel-bubble-text';
    const textNode = document.createTextNode('');
    textEl.appendChild(textNode);
    bubble.appendChild(textEl);

    mount.container.appendChild(bubble);

    const coalescer = createDeltaCoalescer((chunk) => {
      const wasNear = isNearBottom(mount.container);
      textNode.textContent += chunk;
      if (wasNear) mount.container.scrollTop = mount.container.scrollHeight;
    });

    mount.turnRenders.set(turn.turnId, { textNode, coalescer, renderedLength: 0, finalized: false });
  }
  mount.renderedTurnCount = turns.length;

  // Append-only: apply the new slice of text for every turn not yet
  // finalized (covers both brand-new bubbles seeded above and in-progress
  // ones carried over from a previous sync). Never touches the bubble
  // structure — only the text node's content.
  for (const turn of turns) {
    const render = mount.turnRenders.get(turn.turnId);
    if (!render || render.finalized) continue;

    if (turn.done) {
      // Canonical text wins (codex turns arrive whole, with no prior
      // deltas) — flush anything buffered, then overwrite, not append.
      render.coalescer.flush();
      const wasNear = isNearBottom(mount.container);
      render.textNode.textContent = turn.text;
      if (wasNear) mount.container.scrollTop = mount.container.scrollHeight;
      render.finalized = true;
      render.renderedLength = turn.text.length;
    } else if (turn.text.length > render.renderedLength) {
      const chunk = turn.text.slice(render.renderedLength);
      render.renderedLength = turn.text.length;
      render.coalescer.push(chunk);
    }
  }
}

function syncModeratorNotes(mount: DebateMount, source: DebateSource): void {
  const notes = source.moderatorNotes;
  for (let i = mount.renderedNoteCount; i < notes.length; i++) {
    const note = notes[i];
    const chip = document.createElement('div');
    chip.className = `counsel-moderator-chip counsel-moderator-${note.decision}`;
    chip.textContent = note.note;
    mount.container.appendChild(chip);
  }
  mount.renderedNoteCount = notes.length;
}

/**
 * Renders the real verdict card (agreed points, disagreements, adjudicator
 * lean, confidence badge, copy action, de-anonymization — see
 * verdict-card.ts) exactly once, after the turns/notes are in.
 *
 * `question` comes from `source.prompt` for a read-only `CounselResult` —
 * `ActiveCounsel` carries no prompt text, so a live debate's card omits the
 * question line from the copied markdown.
 */
function syncVerdict(mount: DebateMount, source: DebateSource): void {
  if (mount.verdictRendered) return;
  const verdict = getVerdict(source);
  if (!verdict) return;

  const question = isActiveSource(source) ? undefined : source.prompt;
  mount.container.appendChild(renderVerdictCard(verdict, source.seats, question));
  mount.verdictRendered = true;
}

function computeStatusText(source: ActiveCounsel): string {
  if (source.error) return `Error: ${source.error}`;

  switch (source.status) {
    case 'context':
      return 'Gathering project context…';
    case 'debating': {
      const round = source.turns.length > 0 ? source.turns[source.turns.length - 1].round : 1;
      const seatName = source.activeSeat ? source.seats[source.activeSeat].memberName : null;
      return seatName ? `Round ${round} — ${seatName} is thinking…` : `Round ${round}…`;
    }
    case 'moderating':
      return 'Moderator reviewing…';
    case 'adjudicating':
      return 'Adjudicating…';
    case 'done':
      return 'Debate finished.';
  }
}

function syncStatus(mount: DebateMount, source: DebateSource): void {
  if (!mount.isActive || !mount.statusEl) return;
  const active = source as ActiveCounsel;
  mount.statusEl.textContent = computeStatusText(active);

  if (active.status === 'done' && !mount.doneHandled) {
    mount.doneHandled = true;

    if (mount.stopBtn) {
      mount.stopBtn.disabled = true;
      mount.stopBtn.classList.add('hidden');
    }

    const newCounselBtn = document.createElement('button');
    newCounselBtn.type = 'button';
    newCounselBtn.className = 'counsel-btn counsel-btn-primary';
    newCounselBtn.textContent = 'New counsel';
    newCounselBtn.addEventListener('click', () => {
      clearActiveCounsel();
    });
    (mount.statusEl.parentElement ?? mount.container).appendChild(newCounselBtn);
  }
}
