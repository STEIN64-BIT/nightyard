// Workers do not all name the summary the same way ("§1 TL;DR", "0. TLDR",
// "The short version"). Accept the common spellings, optionally prefixed by
// a section number, and require a word boundary so "Summary-table" is not one.
const SUMMARY_HEADING =
  /^(#{2,3})[ \t]*(?:§?\d+[.):]?[ \t]*[—-]?[ \t]*)?(TL;?DR|Summary|Executive summary|The short version|Samenvatting|In het kort)(?![\w-]).*$/im;

const FALLBACK_LIMIT = 750;

export interface Summary {
  text: string;
  found: boolean;
}

export function extractSummary(md: string): Summary {
  const heading = SUMMARY_HEADING.exec(md);
  if (heading) {
    const rest = md.slice(heading.index + heading[0].length);
    const next = rest.search(/^#{1,3}[ \t]/m);
    return { text: (next === -1 ? rest : rest.slice(0, next)).trim(), found: true };
  }
  // No summary written: take the first real paragraphs, skipping the
  // header block (headings, **Key:** lines, quotes, rules, tables) that
  // precedes them, and stopping once a later heading starts the next
  // section.
  const blocks = md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const isHeaderLike = (p: string) => /^(#|\*\*[^*\n]{1,40}:\*\*|>|---|\|)/.test(p);
  let text = '';
  for (const p of blocks) {
    if (!text && isHeaderLike(p)) continue;
    if (text && /^#/.test(p)) break;
    if (text.length > FALLBACK_LIMIT) break;
    text += (text ? '\n\n' : '') + p;
  }
  return { text, found: false };
}

export function extractTitle(md: string, fallback: string): string {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(md);
  return m?.[1] ?? fallback;
}
