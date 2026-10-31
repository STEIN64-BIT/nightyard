import type { CounselModeratorDecision, CounselSeat, CounselSeatConfig, CounselTurnRecord } from '../../shared/types';
import { extractJsonObject } from './json-extract';
import { buildModeratorPrompt } from './prompts';

const VALID_DECISIONS: CounselModeratorDecision[] = ['continue', 'converged', 'redirect'];

function safeDefault(): { decision: CounselModeratorDecision; note: string } {
  return { decision: 'continue', note: '' };
}

/** A bad moderator response must never kill an in-flight debate. */
export function parseModeratorResult(raw: string): { decision: CounselModeratorDecision; note: string } {
  const obj = extractJsonObject(raw);
  if (!obj) return safeDefault();
  const decision = obj['decision'];
  if (typeof decision !== 'string' || !VALID_DECISIONS.includes(decision as CounselModeratorDecision)) {
    return safeDefault();
  }
  const note = typeof obj['note'] === 'string' ? obj['note'] : '';
  return { decision: decision as CounselModeratorDecision, note };
}

export async function moderate(
  runOneShot: (prompt: string) => Promise<string>,
  question: string,
  turns: CounselTurnRecord[],
  seats: Record<CounselSeat, CounselSeatConfig>,
): Promise<{ decision: CounselModeratorDecision; note: string }> {
  try {
    const raw = await runOneShot(buildModeratorPrompt(question, turns, seats));
    return parseModeratorResult(raw);
  } catch {
    return safeDefault();
  }
}
