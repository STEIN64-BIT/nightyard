import { describe, it, expect } from 'vitest';
import {
  STYLE_DIRECTIVES, buildTurnPrompt, buildModeratorPrompt, buildAdjudicatorPrompt,
  buildContextPassPrompt, formatTranscript, MODERATOR_SYSTEM_PROMPT, ADJUDICATOR_SYSTEM_PROMPT,
} from './prompts';
import type { CounselSeat, CounselSeatConfig, CounselTurnRecord } from '../../shared/types';

const seats: Record<CounselSeat, CounselSeatConfig> = {
  A: { memberId: '1', memberName: 'Morgan Prime', memberRole: 'Butler', providerId: 'claude' },
  B: { memberId: '2', memberName: 'Staff Engineer', memberRole: 'Engineer', providerId: 'claude' },
  C: { memberId: '3', memberName: 'Morgan Codex', memberRole: 'Coding familiar', providerId: 'codex' },
};
const turn = (seat: CounselSeat, round: number, text: string): CounselTurnRecord =>
  ({ turnId: `${seat}${round}`, seat, round, text });

describe('buildTurnPrompt', () => {
  const base = { question: 'Ship Acme now?', contextBrief: null, seats, redirectNote: null, style: 'balanced' as const };

  it('turn 1 instructs the opener by persona name', () => {
    const p = buildTurnPrompt({ ...base, turns: [], seat: 'A' });
    expect(p).toContain('You are Morgan Prime');
    expect(p).toContain('Open the debate');
    expect(p).toContain('Ship Acme now?');
    expect(p).toContain(STYLE_DIRECTIVES.balanced);
  });

  it('turn 2 instructs a direct response naming the opener', () => {
    const p = buildTurnPrompt({ ...base, turns: [turn('A', 1, 'yes ship it')], seat: 'B' });
    expect(p).toContain('You are Staff Engineer');
    expect(p).toContain("Morgan Prime's");
    expect(p).toContain('Morgan Prime: yes ship it');
  });

  it('turn 3 asks to respond to both and add something new', () => {
    const p = buildTurnPrompt({ ...base, turns: [turn('A', 1, 'x'), turn('B', 1, 'y')], seat: 'C' });
    expect(p).toContain('You are Morgan Codex');
    expect(p).toContain('add something new');
  });

  it('later turns instruct continue without repeating', () => {
    const p = buildTurnPrompt({ ...base, turns: [turn('A', 1, 'x'), turn('B', 1, 'y'), turn('C', 1, 'z')], seat: 'A' });
    expect(p).toContain('Do not repeat points already made');
  });

  it('includes the context brief when present', () => {
    const p = buildTurnPrompt({ ...base, contextBrief: 'Repo uses Stripe.', turns: [], seat: 'A' });
    expect(p).toContain('Project context:\nRepo uses Stripe.');
  });

  it('includes a pending moderator redirect note', () => {
    const p = buildTurnPrompt({ ...base, redirectNote: 'Focus on pricing.', turns: [], seat: 'A' });
    expect(p).toContain('Moderator guidance: Focus on pricing.');
  });

  it('thorough style appends no directive', () => {
    const p = buildTurnPrompt({ ...base, style: 'thorough', turns: [], seat: 'A' });
    expect(p).not.toContain(STYLE_DIRECTIVES.balanced);
    expect(p).not.toContain(STYLE_DIRECTIVES.punchy);
  });
});

describe('formatTranscript', () => {
  it('labels turns with persona names and separates rounds', () => {
    const t = formatTranscript([turn('A', 1, 'aa'), turn('B', 1, 'bb'), turn('C', 1, 'cc'), turn('A', 2, 'dd')], seats);
    expect(t).toContain('=== Round 1 ===');
    expect(t).toContain('=== Round 2 ===');
    expect(t).toContain('Morgan Prime: aa');
    expect(t.indexOf('=== Round 2 ===')).toBeGreaterThan(t.indexOf('Morgan Codex: cc'));
  });
});

describe('one-shot prompts', () => {
  it('moderator system prompt pins the full JSON contract', () => {
    for (const phrase of ['"decision"', '"continue"', '"converged"', '"redirect"', '"note"']) {
      expect(MODERATOR_SYSTEM_PROMPT).toContain(phrase);
    }
  });
  it('moderator prompt embeds question and transcript', () => {
    const p = buildModeratorPrompt('Q?', [turn('A', 1, 'aa')], seats);
    expect(p).toContain('Q?');
    expect(p).toContain('Morgan Prime: aa');
  });
  it('adjudicator system prompt pins the full JSON contract', () => {
    for (const phrase of [
      'agreedPoints', 'disagreements', 'positions', 'adjudicatorLean',
      'recommendation', 'openQuestions', 'confidence',
      '"A"|"B"|"C"|"none"', '"high"|"medium"|"low"', 'merit only',
    ]) {
      expect(ADJUDICATOR_SYSTEM_PROMPT).toContain(phrase);
    }
  });
  it('adjudicator prompt embeds the anonymized transcript', () => {
    const p = buildAdjudicatorPrompt('Q?', '=== Round 1 ===\nAgent A: aa');
    expect(p).toContain('Agent A: aa');
  });
  it('context-pass prompt forbids taking a position', () => {
    const p = buildContextPassPrompt('Q?');
    expect(p).toContain('Do not take a position');
    expect(p).toContain('Q?');
  });
});
