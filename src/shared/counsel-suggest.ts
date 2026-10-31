import type { TeamMember } from './types';

/** Pure keyword-overlap scoring — no LLM call. Top 3 distinct members. */
export function suggestSeats(question: string, members: TeamMember[]): TeamMember[] {
  const tokens = new Set(
    question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
  );
  const scored = members.map((m, index) => {
    const haystack = `${m.name} ${m.role} ${m.description ?? ''} ${m.domain ?? ''}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 1;
    }
    return { m, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, 3).map((s) => s.m);
}
