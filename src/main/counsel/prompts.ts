import type { CounselSeat, CounselSeatConfig, CounselStyle, CounselTurnRecord } from '../../shared/types';

export const STYLE_DIRECTIVES: Record<CounselStyle, string> = {
  punchy:
    'Keep it punchy: 1-2 sentences, ~250 characters max, one sharp point per turn. No preamble, no lists.',
  balanced:
    'Keep it tight and conversational: 2-3 sentences, ~450 characters max, one main point per turn. ' +
    'Respond directly to the latest point. No preamble, no bullet lists.',
  thorough: '',
};

export function formatTranscript(
  turns: CounselTurnRecord[],
  seats: Record<CounselSeat, CounselSeatConfig>,
): string {
  const lines: string[] = [];
  let currentRound = 0;
  for (const t of turns) {
    if (t.round !== currentRound) {
      currentRound = t.round;
      lines.push(`=== Round ${currentRound} ===`);
    }
    lines.push(`${seats[t.seat].memberName}: ${t.text}`);
  }
  return lines.join('\n\n');
}

function turnInstruction(
  seat: CounselSeat,
  turnCount: number,
  seats: Record<CounselSeat, CounselSeatConfig>,
): string {
  const me = seats[seat].memberName;
  if (turnCount === 0) {
    return `You are ${me}. Open the debate: state your position clearly and argue for it.`;
  }
  if (turnCount === 1) {
    return `You are ${me}. Respond directly to ${seats.A.memberName}'s position above. Agree where warranted, rebut where you disagree, and argue your own position.`;
  }
  if (turnCount === 2) {
    return `You are ${me}. Two positions are on the table. Respond to both: where do you agree with each, where do you disagree, and what is your own position? Do not just pick a side — add something new.`;
  }
  return `You are ${me}. Continue the debate: respond to the latest arguments above, sharpening or revising your position in light of the exchange. Do not repeat points already made.`;
}

export function buildTurnPrompt(args: {
  question: string;
  contextBrief: string | null;
  turns: CounselTurnRecord[];
  seats: Record<CounselSeat, CounselSeatConfig>;
  seat: CounselSeat;
  redirectNote: string | null;
  style: CounselStyle;
}): string {
  const parts: string[] = [`The question under debate:\n${args.question}`];
  if (args.contextBrief) parts.push(`Project context:\n${args.contextBrief}`);
  if (args.turns.length > 0) parts.push(`The debate so far:\n\n${formatTranscript(args.turns, args.seats)}`);
  if (args.redirectNote) parts.push(`Moderator guidance: ${args.redirectNote}`);
  parts.push(turnInstruction(args.seat, args.turns.length, args.seats));
  const directive = STYLE_DIRECTIVES[args.style];
  if (directive) parts.push(directive);
  return parts.join('\n\n');
}

export const MODERATOR_SYSTEM_PROMPT =
  'You are the moderator of a debate between three AI personas. Read the debate. Decide: ' +
  '"converged" if they now substantially agree or are only restating points; ' +
  '"redirect" (with a short steering note) if they are stuck, circling, or drifting off the original question; ' +
  'otherwise "continue". ' +
  'Reply with ONLY a JSON object: {"decision": "continue"|"converged"|"redirect", "note": "string"}. ' +
  'The note is required for redirect, optional otherwise.';

export function buildModeratorPrompt(
  question: string,
  turns: CounselTurnRecord[],
  seats: Record<CounselSeat, CounselSeatConfig>,
): string {
  return `${MODERATOR_SYSTEM_PROMPT}\n\nThe original question:\n${question}\n\nThe debate so far:\n\n${formatTranscript(turns, seats)}`;
}

export const ADJUDICATOR_SYSTEM_PROMPT =
  'You are a blind adjudicator. Three anonymous agents debated the question below. ' +
  'Produce ONLY a JSON object with: agreedPoints (string[]), ' +
  'disagreements (array of {topic, positions: {A, B, C}, adjudicatorLean: "A"|"B"|"C"|"none", rationale}), ' +
  'recommendation (the single actionable answer, string), openQuestions (string[]), ' +
  'confidence ("high"|"medium"|"low"). Judge arguments on merit only.';

export function buildAdjudicatorPrompt(question: string, anonymizedTranscript: string): string {
  return `${ADJUDICATOR_SYSTEM_PROMPT}\n\nThe question:\n${question}\n\nThe debate transcript:\n\n${anonymizedTranscript}`;
}

export function buildContextPassPrompt(question: string): string {
  return (
    'Three AI personas are about to debate the question below about this project. ' +
    'Gather the minimal context needed to debate it well: relevant files, current state, constraints. ' +
    'Output a neutral factual brief, max ~600 words. Do not take a position on the question.\n\n' +
    `The question:\n${question}`
  );
}
