import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptPath, parseTranscriptLines, readTranscriptDelta, MAX_READ_BYTES } from './transcript-delta';

const u = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
const a = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });

const createdDirs: string[] = [];

function writeTmp(content: string): { cwd: string; cli: string; file: string } {
  const cli = `test-${Math.random().toString(36).slice(2)}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wakey-cwd-'));
  const file = transcriptPath(cwd, cli);
  const projectsDir = path.dirname(file);
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(file, content);
  createdDirs.push(cwd, projectsDir);
  return { cwd, cli, file };
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('transcript-delta', () => {
  it('derives the claude projects slug path', () => {
    expect(transcriptPath('/Users/x/proj', 'abc')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-Users-x-proj', 'abc.jsonl'),
    );
  });

  it('parses user/assistant messages and skips synthetics + non-message lines', () => {
    const text = parseTranscriptLines([
      u('<local-command-stdout>x</local-command-stdout>'),
      u('real question'),
      JSON.stringify({ type: 'system' }),
      a('real answer'),
      'not json',
    ], 14);
    expect(text).toBe('USER: real question\n\nASSISTANT: real answer');
  });

  it('full read from offset 0 keeps only the last 14 messages', () => {
    const lines = Array.from({ length: 20 }, (_, i) => u(`m${i}`));
    const { cwd, cli } = writeTmp(lines.join('\n') + '\n');
    const d = readTranscriptDelta(cwd, cli, 0);
    expect(d.full).toBe(true);
    expect(d.text).not.toContain('m5');
    expect(d.text).toContain('m19');
    expect(d.newOffset).toBeGreaterThan(0);
  });

  it('delta read returns only new complete lines and advances the offset', () => {
    const first = u('one') + '\n';
    const { cwd, cli, file } = writeTmp(first);
    const d1 = readTranscriptDelta(cwd, cli, 0);
    fs.appendFileSync(file, u('two') + '\n' + a('three').slice(0, 10)); // partial trailing line
    const d2 = readTranscriptDelta(cwd, cli, d1.newOffset);
    expect(d2.full).toBe(false);
    expect(d2.text).toBe('USER: two');
    const d3 = readTranscriptDelta(cwd, cli, d2.newOffset);
    expect(d3.text).toBe(''); // partial line still incomplete
  });

  it('falls back to a full read when the file shrank below the offset', () => {
    const { cwd, cli, file } = writeTmp(u('long message padding padding') + '\n');
    const big = readTranscriptDelta(cwd, cli, 0);
    fs.writeFileSync(file, u('tiny') + '\n');
    const d = readTranscriptDelta(cwd, cli, big.newOffset);
    expect(d.full).toBe(true);
    expect(d.text).toBe('USER: tiny');
  });

  it('reads only a bounded tail of a huge transcript and skips the cut-off first record', () => {
    const filler = u('x'.repeat(1000)) + '\n';
    const early = u('ancient history') + '\n';
    const pad = filler.repeat(Math.ceil((MAX_READ_BYTES + 4096) / filler.length));
    const { cwd, cli, file } = writeTmp(early + pad + u('latest goal') + '\n');
    const d = readTranscriptDelta(cwd, cli, 0);
    expect(d.full).toBe(true);
    expect(d.text).not.toContain('ancient history');
    expect(d.text.endsWith('USER: latest goal')).toBe(true);
    expect(d.newOffset).toBe(fs.statSync(file).size);
  });

  it('missing file yields empty text at the same offset', () => {
    const d = readTranscriptDelta('/nope/never', 'ghost', 42);
    expect(d).toEqual({ text: '', newOffset: 42, full: false });
  });
});
