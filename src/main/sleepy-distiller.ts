import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DistillInput {
  sessionName: string;
  projectName: string;
  summary: string;          // raw run output (ANSI ok) or pre-distilled markdown
  sourceNoteId?: string;    // vault note the session was launched from, if any
  date: Date;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g;
/** Spinner/stream noise emitted by CLI workers — never knowledge. */
const NOISE = /^\s*(?:[▸│╭╰─┃┆·⋮]|↳|\(thinking…?\)|\$\s|❯)/u;

/**
 * Turn raw sleepy/agent terminal output into a structured markdown body:
 * an Outcomes list (worker "✓ produced …" lines), a Timeline of orchestrator
 * decisions (`sleepy:` lines, truncated), and a short cleaned tail excerpt.
 *
 * Input that already reads as prose/markdown (no transcript noise) is passed
 * through unchanged so hand-written summaries survive.
 */
export function structureSummary(raw: string): string {
  const clean = raw.replace(ANSI, '');
  const lines = clean.split(/\r?\n|\r/);
  const isTranscript = lines.some((l) => NOISE.test(l) || l.trim().startsWith('sleepy:'));
  if (!isTranscript) return clean.trim();

  const outcomes: string[] = [];
  const timeline: string[] = [];
  const tail: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || NOISE.test(line)) continue;
    if (t.startsWith('sleepy:')) {
      const entry = t.slice('sleepy:'.length).trim().replace(/\s+/g, ' ');
      const short = entry.length > 300 ? entry.slice(0, 300) + '…' : entry;
      timeline.push(short);
      if (/[✓✔]|produced|finished/.test(entry)) outcomes.push(short);
      continue;
    }
    tail.push(t.replace(/\s+/g, ' '));
  }

  const parts: string[] = [];
  parts.push('## Outcomes\n');
  parts.push(outcomes.length ? outcomes.map((o) => `- ${o}`).join('\n') : '- (no explicit outcomes captured)');
  if (timeline.length) {
    parts.push('\n\n## Timeline\n');
    parts.push(timeline.map((t) => `- ${t}`).join('\n'));
  }
  const tailText = tail.join('\n').slice(-2000);
  if (tailText) {
    parts.push('\n\n## Output excerpt\n');
    parts.push('```text\n' + tailText + '\n```');
  }
  return parts.join('');
}

export function distillToVault(vaultRoot: string, input: DistillInput): string {
  // Only ever write into a vault that already exists — never create one (e.g.
  // the unconfigured default) in the user's home directory.
  if (!vaultRoot) {
    throw new Error('No knowledge vault configured — set Preferences → Knowledge vault path');
  }
  if (!existsSync(vaultRoot)) {
    throw new Error(`Knowledge vault not found at ${vaultRoot} — check Preferences → Knowledge vault path`);
  }
  const dir = join(vaultRoot, 'Sessions');
  mkdirSync(dir, { recursive: true });
  const day = input.date.toISOString().slice(0, 10);
  // Collapse all whitespace runs (incl. newlines) to single spaces before unsafe-char replace
  const collapsedName = input.sessionName.replace(/\s+/g, ' ');
  const safe = collapsedName.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
  let rel = `Sessions/${day} ${safe}.md`;
  for (let i = 2; existsSync(join(vaultRoot, rel)); i++) rel = `Sessions/${day} ${safe} ${i}.md`;

  // Sanitize projectName for tags: collapse commas and whitespace runs into single hyphens
  const safeProjectName = input.projectName.replace(/[,\s]+/g, '-');
  const backlink = input.sourceNoteId ? `\nLaunched from: [[${input.sourceNoteId.replace(/\.md$/, '')}]]\n` : '\n';
  const body = structureSummary(input.summary);
  const content = `---\ntags: session, ${safeProjectName}\nproject: ${safeProjectName}\ndate: ${day}\n---\n# ${collapsedName}\n${backlink}\n${body}\n`;
  writeFileSync(join(vaultRoot, rel), content, 'utf-8');
  return rel;
}
