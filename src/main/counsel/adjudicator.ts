import type { CounselSeat, CounselSeatConfig, CounselTurnRecord, CounselVerdict } from '../../shared/types';
import { COUNSEL_SEATS } from '../../shared/types';
import { extractJsonObject } from './json-extract';
import { buildAdjudicatorPrompt, formatTranscript } from './prompts';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace persona names and provider brand strings with Agent A/B/C.
 * Regexes are created fresh per call (shared /g regexes carry lastIndex state).
 * Replacement inside code blocks is intentional.
 */
export function anonymizeTranscript(text: string, seats: Record<CounselSeat, CounselSeatConfig>): string {
  let out = text;
  // Longest names first so 'Morgan Codex' is not half-eaten by a shorter overlapping name.
  const bySeatNameLength = [...COUNSEL_SEATS].sort(
    (a, b) => seats[b].memberName.length - seats[a].memberName.length,
  );
  for (const seat of bySeatNameLength) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(seats[seat].memberName)}\\b`, 'gi'), `Agent ${seat}`);
  }
  for (const brand of ['claude', 'codex'] as const) {
    const seat = COUNSEL_SEATS.find((s) => seats[s].providerId === brand);
    if (!seat) continue;
    out = out.replace(new RegExp(`\\b${brand}(?:-[a-z0-9.]+)*(?![a-z0-9])`, 'gi'), `Agent ${seat}`);
  }
  return out;
}

export function isCounselVerdict(v: unknown): v is CounselVerdict {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const stringArray = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  if (!stringArray(o['agreedPoints']) || !stringArray(o['openQuestions'])) return false;
  if (typeof o['recommendation'] !== 'string') return false;
  if (!['high', 'medium', 'low'].includes(o['confidence'] as string)) return false;
  if (!Array.isArray(o['disagreements'])) return false;
  return (o['disagreements'] as unknown[]).every((d) => {
    if (!d || typeof d !== 'object') return false;
    const dd = d as Record<string, unknown>;
    const pos = dd['positions'] as Record<string, unknown> | undefined;
    return (
      typeof dd['topic'] === 'string' &&
      typeof dd['rationale'] === 'string' &&
      [...COUNSEL_SEATS, 'none'].includes(dd['adjudicatorLean'] as string) &&
      !!pos && COUNSEL_SEATS.every((s) => typeof pos[s] === 'string')
    );
  });
}

/** Throws on any failure — the orchestrator catches and builds the fallback verdict. */
export async function adjudicate(
  runOneShot: (prompt: string) => Promise<string>,
  question: string,
  turns: CounselTurnRecord[],
  seats: Record<CounselSeat, CounselSeatConfig>,
): Promise<CounselVerdict> {
  const transcript = anonymizeTranscript(formatTranscript(turns, seats), seats);
  const blindQuestion = anonymizeTranscript(question, seats);
  const raw = await runOneShot(buildAdjudicatorPrompt(blindQuestion, transcript));
  const obj = extractJsonObject(raw);
  if (!obj || !isCounselVerdict(obj)) {
    throw new Error('adjudicator returned no valid verdict');
  }
  return obj;
}

export function buildFallbackVerdict(turns: CounselTurnRecord[]): CounselVerdict {
  const lastBySeat: Record<CounselSeat, string> = { A: '', B: '', C: '' };
  for (const t of turns) lastBySeat[t.seat] = t.text.slice(-400);
  return {
    agreedPoints: [],
    disagreements: [{
      topic: 'Adjudication unavailable',
      positions: lastBySeat,
      adjudicatorLean: 'none',
      rationale: 'The adjudicator call failed; these are the final ~400 characters of each debater.',
    }],
    recommendation: 'Adjudication failed — read the transcript above and judge for yourself.',
    openQuestions: [],
    confidence: 'low',
  };
}
