import { describe, it, expect } from 'vitest';
import { anonymizeTranscript, isCounselVerdict, adjudicate, buildFallbackVerdict } from './adjudicator';
import type { CounselSeat, CounselSeatConfig, CounselTurnRecord } from '../../shared/types';

const seats: Record<CounselSeat, CounselSeatConfig> = {
  A: { memberId: '1', memberName: 'Morgan Prime', memberRole: 'Butler', providerId: 'claude' },
  B: { memberId: '2', memberName: 'Staff Engineer', memberRole: 'Eng', providerId: 'claude' },
  C: { memberId: '3', memberName: 'Morgan Codex', memberRole: 'Familiar', providerId: 'codex' },
};

const validVerdict = {
  agreedPoints: ['p1'],
  disagreements: [{ topic: 't', positions: { A: 'a', B: 'b', C: 'c' }, adjudicatorLean: 'A', rationale: 'r' }],
  recommendation: 'do x',
  openQuestions: [],
  confidence: 'high',
};

describe('anonymizeTranscript', () => {
  it('replaces multi-word persona names case-insensitively', () => {
    const out = anonymizeTranscript('morgan prime disagrees with Staff Engineer', seats);
    expect(out).toBe('Agent A disagrees with Agent B');
  });
  it('longer names win over prefixes (Morgan Codex is not half-replaced by Morgan Prime)', () => {
    expect(anonymizeTranscript('Morgan Codex said so', seats)).toBe('Agent C said so');
  });
  it('replaces brand strings with hyphenated model-id tails', () => {
    expect(anonymizeTranscript('claude-opus-4-7 and codex agree', seats)).toBe('Agent A and Agent C agree');
  });
  it('replaces names inside code blocks (intentional)', () => {
    expect(anonymizeTranscript('```\nMorgan Prime: yes\n```', seats)).toBe('```\nAgent A: yes\n```');
  });
  it('is stateless across calls (fresh regexes per call)', () => {
    const input = 'Morgan Prime Morgan Prime';
    expect(anonymizeTranscript(input, seats)).toBe(anonymizeTranscript(input, seats));
  });
  it('does not mangle words that merely start with a brand', () => {
    expect(anonymizeTranscript('Codexes and claudean prose survive', seats))
      .toBe('Codexes and claudean prose survive');
  });
});

describe('isCounselVerdict', () => {
  it('accepts a valid verdict', () => expect(isCounselVerdict(validVerdict)).toBe(true));
  it('rejects missing fields and wrong types', () => {
    expect(isCounselVerdict({ ...validVerdict, recommendation: 7 })).toBe(false);
    expect(isCounselVerdict({ ...validVerdict, confidence: 'sure' })).toBe(false);
    expect(isCounselVerdict(null)).toBe(false);
    const { agreedPoints, ...rest } = validVerdict;
    expect(isCounselVerdict(rest)).toBe(false);
  });
});

describe('adjudicate', () => {
  const turns: CounselTurnRecord[] = [{ turnId: '1', seat: 'A', round: 1, text: 'Morgan Prime thinks yes' }];

  it('returns the parsed verdict and anonymizes the prompt it sends', async () => {
    let sent = '';
    const v = await adjudicate(async (p) => { sent = p; return JSON.stringify(validVerdict); }, 'q', turns, seats);
    expect(v.recommendation).toBe('do x');
    expect(sent).not.toContain('Morgan Prime');
    expect(sent).toContain('Agent A');
  });
  it('throws on unparseable output', async () => {
    await expect(adjudicate(async () => 'not json at all', 'q', turns, seats)).rejects.toThrow();
  });
  it('throws on shape-invalid verdict', async () => {
    await expect(adjudicate(async () => '{"agreedPoints": []}', 'q', turns, seats)).rejects.toThrow();
  });
  it('anonymizes the question before the adjudicator sees it', async () => {
    let sent = '';
    await adjudicate(async (p) => { sent = p; return JSON.stringify(validVerdict); }, 'What would Morgan Prime say?', turns, seats);
    expect(sent).not.toContain('Morgan Prime');
    expect(sent).toContain('What would Agent A say?');
  });
});

describe('buildFallbackVerdict', () => {
  it('is low confidence and quotes the tail of each seat final turn', () => {
    const turns: CounselTurnRecord[] = [
      { turnId: '1', seat: 'A', round: 1, text: 'old A' },
      { turnId: '2', seat: 'B', round: 1, text: 'B'.repeat(500) },
      { turnId: '3', seat: 'A', round: 2, text: 'final A position' },
    ];
    const v = buildFallbackVerdict(turns);
    expect(v.confidence).toBe('low');
    expect(v.disagreements[0].topic).toBe('Adjudication unavailable');
    expect(v.disagreements[0].positions.A).toBe('final A position');
    expect(v.disagreements[0].positions.B).toHaveLength(400);
    expect(v.disagreements[0].positions.C).toBe('');
    expect(v.recommendation).toMatch(/transcript/i);
  });
});
