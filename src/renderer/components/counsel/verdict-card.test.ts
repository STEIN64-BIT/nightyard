import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CounselSeatConfig, CounselVerdict } from '../../../shared/types.js';
import { deAnonymizeVerdictText, renderVerdictCard } from './verdict-card.js';

// --- Minimal hand-rolled fake DOM ---
// This repo's vitest environment is 'node' (no jsdom/happy-dom installed);
// other renderer component tests needing DOM stub `document`/`window` with a
// small hand-rolled element shim (see session-inspector-timeline.test.ts,
// session-history.test.ts). This one additionally implements a real
// aggregating `textContent` getter (sums descendant text), matching actual
// DOM semantics — needed because the brief's own test reads `.textContent`
// off the *top-level* card, not a specific leaf.

type FakeChild = FakeElement | { textContent: string };

class FakeElement {
  className = '';
  parentElement: FakeElement | null = null;
  children: FakeChild[] = [];
  type = '';
  disabled = false;
  private ownText = '';
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  constructor(public tagName: string) {}

  appendChild(child: FakeChild): FakeChild {
    if (child instanceof FakeElement) child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(event: string, cb: (...a: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  dispatch(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }

  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  querySelectorAll(selector: string): FakeElement[] {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const results: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue;
        if (className && child.className.split(/\s+/).includes(className)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function click(el: FakeElement): void {
  el.dispatch('click');
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeElement(tag),
  });
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Fixtures ---

function seat(name: string, role: string): CounselSeatConfig {
  return { memberId: name.toLowerCase().replace(/\s+/g, '-'), memberName: name, memberRole: role, providerId: 'claude' };
}

const seats: Record<'A' | 'B' | 'C', CounselSeatConfig> = {
  A: seat('Morgan Prime', 'Generalist'),
  B: seat('Skeptic', 'Critic'),
  C: seat('Morgan Codex', 'Coding familiar'),
};

describe('deAnonymizeVerdictText', () => {
  it('maps Agent A/B/C to persona names', () => {
    expect(deAnonymizeVerdictText('Agent A and Agent C agree; AGENT A is not a match', seats))
      .toBe('Morgan Prime and Morgan Codex agree; AGENT A is not a match');
  });

  it('is word-boundary safe (no match inside a longer token) and handles trailing punctuation', () => {
    expect(deAnonymizeVerdictText("Go with Agent A's plan, not Agents Anonymous", seats))
      .toBe("Go with Morgan Prime's plan, not Agents Anonymous");
  });

  it('leaves text with no Agent mentions untouched', () => {
    expect(deAnonymizeVerdictText('No mentions here', seats)).toBe('No mentions here');
  });
});

describe('renderVerdictCard', () => {
  it('shows recommendation, lean names, confidence badge', () => {
    const verdict: CounselVerdict = {
      agreedPoints: ['Ship fast'],
      disagreements: [
        {
          topic: 'Scope',
          positions: { A: 'Go broad', B: 'Go narrow', C: 'Go broad but staged' },
          adjudicatorLean: 'A',
          rationale: 'Broad scope reduces rework',
        },
      ],
      recommendation: 'do x',
      openQuestions: ['What about budget?'],
      confidence: 'high',
    };

    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;
    expect(card.querySelector('.counsel-recommendation')!.textContent).toContain('do x');
    expect(card.textContent).toContain('Morgan Prime'); // de-anonymized lean
    expect(card.querySelector('.counsel-confidence-high')).toBeTruthy();
  });

  it('shows medium/low confidence badges distinctly', () => {
    const base: CounselVerdict = {
      agreedPoints: [],
      disagreements: [],
      recommendation: 'x',
      openQuestions: [],
      confidence: 'medium',
    };
    const medium = renderVerdictCard(base, seats) as unknown as FakeElement;
    expect(medium.querySelector('.counsel-confidence-medium')).toBeTruthy();
    expect(medium.querySelector('.counsel-confidence-high')).toBeNull();

    const low = renderVerdictCard({ ...base, confidence: 'low' }, seats) as unknown as FakeElement;
    expect(low.querySelector('.counsel-confidence-low')).toBeTruthy();
  });

  it('renders "no lean" when adjudicatorLean is none', () => {
    const verdict: CounselVerdict = {
      agreedPoints: [],
      disagreements: [{ topic: 'X', positions: { A: 'a', B: 'b', C: 'c' }, adjudicatorLean: 'none', rationale: 'r' }],
      recommendation: 'x',
      openQuestions: [],
      confidence: 'medium',
    };
    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;
    expect(card.querySelector('.counsel-lean-badge')!.textContent).toBe('Lean: no lean');
  });

  it('renders all three persona positions labeled by seat member name', () => {
    const verdict: CounselVerdict = {
      agreedPoints: [],
      disagreements: [
        {
          topic: 'X',
          positions: { A: 'position a', B: 'position b', C: 'position c' },
          adjudicatorLean: 'B',
          rationale: 'r',
        },
      ],
      recommendation: 'x',
      openQuestions: [],
      confidence: 'medium',
    };
    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;
    const names = card.querySelectorAll('.counsel-position-name').map((n) => n.textContent);
    expect(names).toEqual(['Morgan Prime', 'Skeptic', 'Morgan Codex']);
    const texts = card.querySelectorAll('.counsel-position-text').map((n) => n.textContent);
    expect(texts).toEqual(['position a', 'position b', 'position c']);
    expect(card.querySelector('.counsel-lean-badge')!.textContent).toBe('Lean: Skeptic');
  });

  it('omits agreed-points/disagreements/open-questions sections when empty', () => {
    const verdict: CounselVerdict = {
      agreedPoints: [],
      disagreements: [],
      recommendation: 'x',
      openQuestions: [],
      confidence: 'medium',
    };
    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;
    expect(card.querySelector('.counsel-agreed-item')).toBeNull();
    expect(card.querySelector('.counsel-disagreement')).toBeNull();
    expect(card.querySelector('.counsel-open-question')).toBeNull();
  });

  it('de-anonymizes every free-text field: agreed points, topic, positions, rationale, recommendation, open questions', () => {
    const verdict: CounselVerdict = {
      agreedPoints: ['Agent A and Agent C both want to ship'],
      disagreements: [
        {
          topic: 'Agent B disputes the timeline',
          positions: {
            A: 'Agent A thinks two weeks',
            B: 'Agent B thinks four weeks',
            C: 'Agent C sides with Agent A',
          },
          adjudicatorLean: 'none',
          rationale: 'Agent B raises a valid resourcing concern',
        },
      ],
      recommendation: "Go with Agent A's two-week plan",
      openQuestions: ['Can Agent B get more resourcing?'],
      confidence: 'medium',
    };

    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;

    expect(card.querySelector('.counsel-agreed-item')!.textContent).toBe('Morgan Prime and Morgan Codex both want to ship');
    expect(card.querySelector('.counsel-disagreement-topic')!.textContent).toBe('Skeptic disputes the timeline');
    expect(card.querySelector('.counsel-disagreement-rationale')!.textContent).toBe('Skeptic raises a valid resourcing concern');
    expect(card.querySelector('.counsel-recommendation')!.textContent).toBe("Go with Morgan Prime's two-week plan");
    expect(card.querySelector('.counsel-open-question')!.textContent).toBe('Can Skeptic get more resourcing?');

    const positions = card.querySelectorAll('.counsel-position-text').map((p) => p.textContent);
    expect(positions).toEqual([
      'Morgan Prime thinks two weeks',
      'Skeptic thinks four weeks',
      'Morgan Codex sides with Morgan Prime',
    ]);
  });

  it('renders agreed points and open questions as separate list items', () => {
    const verdict: CounselVerdict = {
      agreedPoints: ['Point one', 'Point two'],
      disagreements: [],
      recommendation: 'x',
      openQuestions: ['Question one', 'Question two'],
      confidence: 'medium',
    };
    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;
    expect(card.querySelectorAll('.counsel-agreed-item').map((n) => n.textContent)).toEqual(['Point one', 'Point two']);
    expect(card.querySelectorAll('.counsel-open-question').map((n) => n.textContent)).toEqual(['Question one', 'Question two']);
  });
});

describe('renderVerdictCard — copy verdict', () => {
  it('writes a de-anonymized markdown rendering to the clipboard and shows quick feedback', () => {
    const verdict: CounselVerdict = {
      agreedPoints: ['Agent A and Agent C agree on scope'],
      disagreements: [
        {
          topic: 'Timeline',
          positions: { A: 'two weeks', B: 'four weeks', C: 'three weeks' },
          adjudicatorLean: 'C',
          rationale: 'Agent C balances risk and speed',
        },
      ],
      recommendation: 'Ship in three weeks',
      openQuestions: ['Budget for QA?'],
      confidence: 'low',
    };

    const card = renderVerdictCard(verdict, seats, 'Should we ship now or wait?') as unknown as FakeElement;
    const copyBtn = card.querySelector('.counsel-copy-verdict-btn')!;
    expect(copyBtn.textContent).toBe('Copy verdict');

    click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const markdown = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string;

    expect(markdown).toContain('Should we ship now or wait?');
    expect(markdown).toContain('Morgan Prime and Morgan Codex agree on scope');
    expect(markdown).toContain('Timeline');
    expect(markdown).toContain('Morgan Codex balances risk and speed'); // de-anonymized rationale
    expect(markdown).toContain('Ship in three weeks');
    expect(markdown).toContain('Budget for QA?');
    expect(markdown).toContain('low');
    expect(markdown).not.toContain('Agent ');

    expect(copyBtn.textContent).toBe('Copied!');
  });

  it('omits the question line when no question is supplied', () => {
    const verdict: CounselVerdict = {
      agreedPoints: [],
      disagreements: [],
      recommendation: 'do y',
      openQuestions: [],
      confidence: 'medium',
    };
    const card = renderVerdictCard(verdict, seats) as unknown as FakeElement;
    click(card.querySelector('.counsel-copy-verdict-btn')!);
    const markdown = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string;
    expect(markdown).not.toContain('Question');
    expect(markdown).toContain('do y');
  });
});
