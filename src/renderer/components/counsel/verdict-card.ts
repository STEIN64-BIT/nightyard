import type { CounselSeat, CounselSeatConfig, CounselVerdict } from '../../../shared/types.js';
import { COUNSEL_SEATS } from '../../../shared/types.js';

/**
 * The adjudicator produces its verdict blind (it never sees which persona
 * sits in which seat), so verdict free text may refer to personas as
 * "Agent A/B/C". This maps those mentions back to real persona names
 * wherever verdict text is rendered or copied. Word-boundary, case-sensitive
 * on the literal 'Agent' — 'AGENT A' is intentionally left untouched.
 */
export function deAnonymizeVerdictText(text: string, seats: Record<CounselSeat, CounselSeatConfig>): string {
  return text.replace(/\bAgent ([ABC])\b/g, (match, letter: CounselSeat) => seats[letter]?.memberName ?? match);
}

function leanLabel(lean: CounselSeat | 'none', seats: Record<CounselSeat, CounselSeatConfig>): string {
  return lean === 'none' ? 'no lean' : seats[lean].memberName;
}

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function renderList(listClass: string, itemClass: string, items: string[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = listClass;
  for (const item of items) list.appendChild(el('li', itemClass, item));
  return list;
}

/** Builds the "Copy verdict" clipboard payload — a readable markdown block, de-anonymized throughout. */
function buildVerdictMarkdown(verdict: CounselVerdict, seats: Record<CounselSeat, CounselSeatConfig>, question?: string): string {
  const dz = (text: string) => deAnonymizeVerdictText(text, seats);
  const lines: string[] = ['# Counsel verdict'];

  if (question) lines.push('', `**Question:** ${dz(question)}`);
  lines.push('', `**Confidence:** ${verdict.confidence}`);
  lines.push('', '## Recommendation', dz(verdict.recommendation));

  if (verdict.agreedPoints.length > 0) {
    lines.push('', '## Agreed points', ...verdict.agreedPoints.map((p) => `- ${dz(p)}`));
  }

  if (verdict.disagreements.length > 0) {
    lines.push('', '## Disagreements');
    for (const d of verdict.disagreements) {
      lines.push('', `### ${dz(d.topic)}`);
      for (const seatKey of COUNSEL_SEATS) {
        lines.push(`- **${seats[seatKey].memberName}:** ${dz(d.positions[seatKey])}`);
      }
      lines.push(`- **Adjudicator lean:** ${leanLabel(d.adjudicatorLean, seats)}`);
      lines.push(`- **Rationale:** ${dz(d.rationale)}`);
    }
  }

  if (verdict.openQuestions.length > 0) {
    lines.push('', '## Open questions', ...verdict.openQuestions.map((q) => `- ${dz(q)}`));
  }

  return lines.join('\n');
}

/**
 * Renders the final Counsel verdict: agreed points, per-disagreement topic +
 * three persona positions + adjudicator-lean badge + rationale, a highlighted
 * recommendation, a confidence badge, open questions, and a "Copy verdict"
 * button. Every free-text field from the (blind) adjudicator output is run
 * through `deAnonymizeVerdictText` before being rendered.
 *
 * `question` is optional — debate-view.ts has no prompt text for a *live*
 * debate (`ActiveCounsel` carries none), only for a finished `CounselResult`
 * (`source.prompt`) — and is included in the copied markdown when supplied.
 */
export function renderVerdictCard(
  verdict: CounselVerdict,
  seats: Record<CounselSeat, CounselSeatConfig>,
  question?: string,
): HTMLElement {
  const dz = (text: string) => deAnonymizeVerdictText(text, seats);

  const card = document.createElement('div');
  card.className = 'counsel-verdict';

  card.appendChild(el('div', `counsel-confidence-badge counsel-confidence-${verdict.confidence}`, `Confidence: ${verdict.confidence}`));
  card.appendChild(el('div', 'counsel-recommendation', dz(verdict.recommendation)));

  if (verdict.agreedPoints.length > 0) {
    const section = document.createElement('div');
    section.className = 'counsel-agreed-points';
    section.appendChild(el('div', 'counsel-verdict-heading', 'Agreed'));
    section.appendChild(renderList('counsel-agreed-list', 'counsel-agreed-item', verdict.agreedPoints.map(dz)));
    card.appendChild(section);
  }

  if (verdict.disagreements.length > 0) {
    const section = document.createElement('div');
    section.className = 'counsel-disagreements';
    section.appendChild(el('div', 'counsel-verdict-heading', 'Disagreements'));

    for (const disagreement of verdict.disagreements) {
      const item = document.createElement('div');
      item.className = 'counsel-disagreement';
      item.appendChild(el('div', 'counsel-disagreement-topic', dz(disagreement.topic)));

      const positions = document.createElement('div');
      positions.className = 'counsel-disagreement-positions';
      for (const seatKey of COUNSEL_SEATS) {
        const position = document.createElement('div');
        position.className = `counsel-position counsel-seat-${seatKey.toLowerCase()}`;
        position.appendChild(el('span', 'counsel-position-name', seats[seatKey].memberName));
        position.appendChild(el('span', 'counsel-position-text', dz(disagreement.positions[seatKey])));
        positions.appendChild(position);
      }
      item.appendChild(positions);

      item.appendChild(el('div', 'counsel-lean-badge', `Lean: ${leanLabel(disagreement.adjudicatorLean, seats)}`));
      item.appendChild(el('div', 'counsel-disagreement-rationale', dz(disagreement.rationale)));

      section.appendChild(item);
    }
    card.appendChild(section);
  }

  if (verdict.openQuestions.length > 0) {
    const section = document.createElement('div');
    section.className = 'counsel-open-questions';
    section.appendChild(el('div', 'counsel-verdict-heading', 'Open questions'));
    section.appendChild(renderList('counsel-open-questions-list', 'counsel-open-question', verdict.openQuestions.map(dz)));
    card.appendChild(section);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'counsel-btn counsel-copy-verdict-btn';
  copyBtn.textContent = 'Copy verdict';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(buildVerdictMarkdown(verdict, seats, question));
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = 'Copy verdict';
    }, 1500);
  });
  card.appendChild(copyBtn);

  return card;
}
