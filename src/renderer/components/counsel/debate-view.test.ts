import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCounsel } from '../../counsel-store.js';
import type { CounselResult, CounselSeatConfig } from '../../../shared/types.js';

const { mockStopCounsel, mockClearActiveCounsel } = vi.hoisted(() => ({
  mockStopCounsel: vi.fn(),
  mockClearActiveCounsel: vi.fn(),
}));

vi.mock('../../counsel-store.js', () => ({
  stopCounsel: mockStopCounsel,
  clearActiveCounsel: mockClearActiveCounsel,
}));

import { renderDebate } from './debate-view.js';

// --- Minimal hand-rolled fake DOM ---
// This repo's vitest environment is 'node' (no jsdom/happy-dom installed);
// other renderer component tests that need DOM (preferences-modal.test.ts,
// share-dialog.test.ts) stub `document`/`window` with a small hand-rolled
// element shim rather than pulling in a DOM library. This matches that
// convention, sized to what debate-view.ts actually touches.

type FakeNode = Record<string, any>;

const domStats = { createElementCalls: 0 };

function makeElement(tagName = 'div'): FakeNode {
  const children: FakeNode[] = [];
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const classSet = new Set<string>();
  const el: FakeNode = {
    tagName,
    children,
    dataset: {},
    className: '',
    textContent: '',
    disabled: false,
    type: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    parentElement: null as FakeNode | null,
    appendChild(child: FakeNode) {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    remove() {
      if (!el.parentElement) return;
      el.parentElement.children = (el.parentElement.children as FakeNode[]).filter((c) => c !== el);
      el.parentElement = null;
    },
    addEventListener(event: string, cb: (...a: any[]) => void) {
      (listeners[event] ??= []).push(cb);
    },
    dispatchEvent(event: { type: string }) {
      for (const cb of listeners[event.type] ?? []) cb(event);
    },
    classList: {
      add(...tokens: string[]) {
        tokens.forEach((t) => classSet.add(t));
      },
      remove(...tokens: string[]) {
        tokens.forEach((t) => classSet.delete(t));
      },
      toggle(token: string, force?: boolean) {
        const shouldAdd = force ?? !classSet.has(token);
        if (shouldAdd) classSet.add(token);
        else classSet.delete(token);
      },
      contains(token: string) {
        return classSet.has(token);
      },
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set(_value: string) {
      children.length = 0;
    },
    configurable: true,
  });
  return el;
}

function click(el: FakeNode): void {
  el.dispatchEvent({ type: 'click' });
}

function findByClass(root: FakeNode, cls: string): FakeNode | null {
  for (const child of (root.children ?? []) as FakeNode[]) {
    if (typeof child.className === 'string' && child.className.split(/\s+/).includes(cls)) return child;
    if (!Array.isArray(child.children)) continue; // leaf (e.g. a text node) — nothing to recurse into
    const nested = findByClass(child, cls);
    if (nested) return nested;
  }
  return null;
}

function findAllByClass(root: FakeNode, cls: string): FakeNode[] {
  const out: FakeNode[] = [];
  for (const child of (root.children ?? []) as FakeNode[]) {
    if (typeof child.className === 'string' && child.className.split(/\s+/).includes(cls)) out.push(child);
    if (Array.isArray(child.children)) out.push(...findAllByClass(child, cls));
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  domStats.createElementCalls = 0;
  vi.stubGlobal('document', {
    createElement(tag: string) {
      domStats.createElementCalls++;
      return makeElement(tag);
    },
    createTextNode(text: string) {
      return { textContent: text };
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Fixtures ---

function seat(name: string, role: string): CounselSeatConfig {
  return { memberId: name.toLowerCase(), memberName: name, memberRole: role, providerId: 'claude' };
}

const SEATS: Record<'A' | 'B' | 'C', CounselSeatConfig> = {
  A: seat('Morgan Prime', 'Generalist'),
  B: seat('Codex Morgan', 'Coding familiar'),
  C: seat('Skeptic', 'Critic'),
};

function makeActive(overrides: Partial<ActiveCounsel> = {}): ActiveCounsel {
  return {
    counselId: 'c1',
    projectId: 'p1',
    seats: SEATS,
    turns: [],
    moderatorNotes: [],
    contextBrief: null,
    status: 'debating',
    activeSeat: null,
    verdict: null,
    error: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<CounselResult> = {}): CounselResult {
  return {
    counselId: 'hist-1',
    prompt: 'Should we ship?',
    seats: SEATS,
    style: 'balanced',
    turns: [{ turnId: 't1', seat: 'A', round: 1, text: 'final answer' }],
    moderatorNotes: [],
    stoppedReason: 'converged',
    startedAt: 0,
    ...overrides,
  };
}

describe('renderDebate — append-only streaming', () => {
  it('creates one bubble per turn and seeds its current text', () => {
    const root = makeElement();
    const active = makeActive({ turns: [{ turnId: 't1', seat: 'A', round: 1, text: 'Hel', done: false }] });

    renderDebate(root, active);

    const container = root.children[0];
    expect(container.className).toBe('counsel-thread');
    expect(container.children).toHaveLength(1);

    const bubble = container.children[0];
    expect(bubble.className).toBe('counsel-bubble counsel-seat-a');
    expect(findByClass(bubble, 'counsel-bubble-name')!.textContent).toBe('Morgan Prime');
    expect(findByClass(bubble, 'counsel-bubble-role')!.textContent).toBe('Generalist');
    expect(findByClass(bubble, 'counsel-bubble-text')!.children[0].textContent).toBe('Hel');
  });

  it('streams deltas by appending to the same text node — no new elements, no rebuild', () => {
    const root = makeElement();
    const active = makeActive({ turns: [{ turnId: 't1', seat: 'A', round: 1, text: 'Hel', done: false }] });
    renderDebate(root, active);

    const container = root.children[0];
    const bubble = container.children[0];
    const textEl = findByClass(bubble, 'counsel-bubble-text')!;
    const textNode = textEl.children[0];

    const elementsAfterFirstRender = domStats.createElementCalls;

    // Simulate a turn-delta: the store mutates turn.text in place.
    active.turns[0].text = 'Hello';
    renderDebate(root, active);

    expect(domStats.createElementCalls).toBe(elementsAfterFirstRender); // no new DOM nodes created
    expect(container.children).toHaveLength(1); // still exactly one bubble
    expect(container.children[0]).toBe(bubble); // same bubble instance
    expect(findByClass(bubble, 'counsel-bubble-text')).toBe(textEl); // same text wrapper
    expect(textEl.children[0]).toBe(textNode); // same text node instance
    expect(textNode.textContent).toBe('Hello'); // grew via append, not a fresh node
  });

  it('auto-scrolls only when the container was already near the bottom before the append', () => {
    const root = makeElement();
    const active = makeActive({ turns: [{ turnId: 't1', seat: 'A', round: 1, text: 'a', done: false }] });
    renderDebate(root, active);
    const container = root.children[0];

    // Not near bottom: appending must not move scrollTop.
    container.scrollTop = 0;
    container.scrollHeight = 1000;
    container.clientHeight = 50;
    active.turns[0].text = 'ab';
    renderDebate(root, active);
    expect(container.scrollTop).toBe(0);

    // Near bottom (within 80px): appending should snap scrollTop to scrollHeight.
    container.scrollTop = 950; // 1000 - 950 - 50 = 0 <= 80
    active.turns[0].text = 'abc';
    renderDebate(root, active);
    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it('turn-end sets the canonical fullText (overwrite, not append) and then ignores further mutation', () => {
    const root = makeElement();
    const active = makeActive({ turns: [{ turnId: 't1', seat: 'B', round: 1, text: 'partial', done: false }] });
    renderDebate(root, active);

    active.turns[0].text = 'the full canonical text';
    active.turns[0].done = true;
    renderDebate(root, active);

    const container = root.children[0];
    const textNode = findByClass(container.children[0], 'counsel-bubble-text')!.children[0];
    expect(textNode.textContent).toBe('the full canonical text');

    // A finalized turn is never touched again, even if its text mutates.
    active.turns[0].text = 'mutated after done';
    renderDebate(root, active);
    expect(textNode.textContent).toBe('the full canonical text');
  });

  it('appends moderator chips and the verdict placeholder exactly once, after the turns', () => {
    const root = makeElement();
    const active = makeActive({
      turns: [{ turnId: 't1', seat: 'A', round: 1, text: 'x', done: true }],
      moderatorNotes: [{ afterRound: 1, decision: 'continue', note: 'keep going' }],
    });
    renderDebate(root, active);

    const container = root.children[0];
    expect(container.children).toHaveLength(2); // bubble + moderator chip
    const chip = container.children[1];
    expect(chip.className).toBe('counsel-moderator-chip counsel-moderator-continue');
    expect(chip.textContent).toBe('keep going');

    // Re-sync with no new notes: no duplicate chip.
    renderDebate(root, active);
    expect(container.children).toHaveLength(2);

    active.verdict = {
      agreedPoints: [],
      disagreements: [],
      recommendation: 'do the thing',
      openQuestions: [],
      confidence: 'high',
    };
    active.status = 'adjudicating';
    renderDebate(root, active);
    expect(container.children).toHaveLength(3);
    const verdictEl = container.children[2];
    // Task 7's real verdict card lives here now — assert its presence (and
    // the recommendation it renders) rather than the old placeholder's exact
    // textContent equality.
    expect(verdictEl.className).toBe('counsel-verdict');
    expect(findByClass(verdictEl, 'counsel-recommendation')!.textContent).toBe('do the thing');
    expect(findByClass(verdictEl, 'counsel-confidence-high')).toBeTruthy();

    // Re-sync: no duplicate verdict element.
    renderDebate(root, active);
    expect(container.children).toHaveLength(3);
  });
});

describe('renderDebate — status line', () => {
  it.each([
    ['context', 'Gathering project context…'],
    ['moderating', 'Moderator reviewing…'],
    ['adjudicating', 'Adjudicating…'],
    ['done', 'Debate finished.'],
  ] as const)('renders the expected text for status "%s"', (status, expected) => {
    const root = makeElement();
    renderDebate(root, makeActive({ status }));
    expect(findByClass(root, 'counsel-status')!.textContent).toBe(expected);
  });

  it('shows the round and active persona name while debating', () => {
    const root = makeElement();
    const active = makeActive({
      status: 'debating',
      activeSeat: 'B',
      turns: [{ turnId: 't1', seat: 'B', round: 2, text: '', done: false }],
    });
    renderDebate(root, active);
    expect(findByClass(root, 'counsel-status')!.textContent).toBe('Round 2 — Codex Morgan is thinking…');
  });

  it('shows the error message regardless of status', () => {
    const root = makeElement();
    renderDebate(root, makeActive({ status: 'debating', error: 'spawn failed' }));
    expect(findByClass(root, 'counsel-status')!.textContent).toBe('Error: spawn failed');
  });
});

describe('renderDebate — live controls', () => {
  it('Stop button calls stopCounsel and disables itself', () => {
    const root = makeElement();
    renderDebate(root, makeActive());

    const stopBtn = findByClass(root, 'counsel-stop-btn')!;
    click(stopBtn);

    expect(mockStopCounsel).toHaveBeenCalledTimes(1);
    expect(stopBtn.disabled).toBe(true);
  });

  it('reaching status done hides Stop and adds one New counsel button wired to clearActiveCounsel', () => {
    const root = makeElement();
    const active = makeActive({ status: 'debating' });
    renderDebate(root, active);
    const stopBtn = findByClass(root, 'counsel-stop-btn')!;

    active.status = 'done';
    renderDebate(root, active);

    expect(stopBtn.classList.contains('hidden')).toBe(true);
    const newCounselButtons = findAllByClass(root, 'counsel-btn-primary').filter((el) => el.textContent === 'New counsel');
    expect(newCounselButtons).toHaveLength(1);

    click(newCounselButtons[0]);
    expect(mockClearActiveCounsel).toHaveBeenCalledTimes(1);

    // Re-syncing while still done must not add a second button.
    renderDebate(root, active);
    expect(findAllByClass(root, 'counsel-btn-primary').filter((el) => el.textContent === 'New counsel')).toHaveLength(1);
  });
});

describe('renderDebate — read-only (CounselResult) source', () => {
  it('renders turns statically with no Stop button or status line', () => {
    const root = makeElement();
    renderDebate(root, makeResult());

    expect(findByClass(root, 'counsel-stop-btn')).toBeNull();
    expect(findByClass(root, 'counsel-status')).toBeNull();

    const container = root.children[0];
    const textNode = findByClass(container.children[0], 'counsel-bubble-text')!.children[0];
    expect(textNode.textContent).toBe('final answer');
  });

  it('New counsel button calls the supplied onBack, not clearActiveCounsel', () => {
    const root = makeElement();
    const onBack = vi.fn();
    renderDebate(root, makeResult(), onBack);

    const backBtn = findByClass(root, 'counsel-btn-primary')!;
    expect(backBtn.textContent).toBe('New counsel');

    click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(mockClearActiveCounsel).not.toHaveBeenCalled();
  });

  it('renders an already-finished verdict statically', () => {
    const root = makeElement();
    renderDebate(
      root,
      makeResult({
        verdict: {
          agreedPoints: [],
          disagreements: [],
          recommendation: 'ship it',
          openQuestions: [],
          confidence: 'medium',
        },
      }),
    );
    const verdictEl = findByClass(root, 'counsel-verdict')!;
    expect(findByClass(verdictEl, 'counsel-recommendation')!.textContent).toBe('ship it');
    expect(findByClass(verdictEl, 'counsel-confidence-medium')).toBeTruthy();
  });
});

describe('renderDebate — structural view switches', () => {
  it('a different counselId on the same root fully rebuilds, discarding prior turns', () => {
    const root = makeElement();
    renderDebate(root, makeActive({ counselId: 'debate-a', turns: [{ turnId: 't1', seat: 'A', round: 1, text: 'from A', done: true }] }));
    renderDebate(root, makeActive({ counselId: 'debate-b', turns: [{ turnId: 't9', seat: 'C', round: 1, text: 'from B', done: true }] }));

    const container = root.children[0];
    expect(container.children).toHaveLength(1);
    const textNode = findByClass(container.children[0], 'counsel-bubble-text')!.children[0];
    expect(textNode.textContent).toBe('from B');
  });
});
