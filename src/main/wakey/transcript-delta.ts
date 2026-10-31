import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TranscriptDelta { text: string; newOffset: number; full: boolean }
const MAX_CHARS = 8000;
// Long-running agent transcripts can be hundreds of MB. Never read more than a
// bounded tail on Electron's main thread — the supervisor only ever sees the
// last few messages / MAX_CHARS anyway.
export const MAX_READ_BYTES = 2 * 1024 * 1024;

export function transcriptPath(cwd: string, cliSessionId: string): string {
  const slug = cwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, `${cliSessionId}.jsonl`);
}

export function parseTranscriptLines(lines: string[], maxMessages: number): string {
  const messages: string[] = [];
  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'user') {
      const content = obj.message?.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      if (!text || text.startsWith('<local-command-') || text.startsWith('<command-name>')) continue;
      messages.push(`USER: ${text}`);
    } else if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      const tools = content.filter((c: any) => c.type === 'tool_use').map((c: any) => `[tool: ${c.name}]`).join(' ');
      const combined = [text, tools].filter(Boolean).join(' ');
      if (combined) messages.push(`ASSISTANT: ${combined}`);
    }
  }
  return messages.slice(-maxMessages).join('\n\n').slice(-MAX_CHARS);
}

export function readTranscriptDelta(cwd: string, cliSessionId: string, fromOffset: number): TranscriptDelta {
  const file = transcriptPath(cwd, cliSessionId);
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { text: '', newOffset: fromOffset, full: false }; }

  const full = fromOffset === 0 || size < fromOffset;
  const wanted = full ? 0 : fromOffset;
  const start = Math.max(wanted, size - MAX_READ_BYTES);
  const clipped = start > wanted;
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const raw = buf.toString('utf-8');

  // Only complete lines; a trailing partial line stays for the next read.
  const lastNl = raw.lastIndexOf('\n');
  if (lastNl === -1) return { text: '', newOffset: clipped ? wanted : start, full };
  let complete = raw.slice(0, lastNl);
  const newOffset = start + Buffer.byteLength(complete, 'utf-8') + 1;
  if (clipped) {
    // We started mid-file: the first line is an incomplete JSON record.
    const firstNl = complete.indexOf('\n');
    complete = firstNl === -1 ? '' : complete.slice(firstNl + 1);
  }
  const text = parseTranscriptLines(complete.split('\n'), full ? 14 : Number.MAX_SAFE_INTEGER);
  return { text, newOffset, full };
}
