import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distillToVault, structureSummary } from './sleepy-distiller';

describe('distillToVault', () => {
  it('refuses to write when no vault is configured', () => {
    expect(() => distillToVault('', {
      sessionName: 's', projectName: 'p', summary: 'x', date: new Date('2026-06-10T10:00:00Z'),
    })).toThrow(/No knowledge vault configured/);
  });

  it('refuses to create a vault that does not exist', () => {
    const missing = join(tmpdir(), `no-such-vault-${process.pid}-${Date.now()}`);
    expect(() => distillToVault(missing, {
      sessionName: 's', projectName: 'p', summary: 'x', date: new Date('2026-06-10T10:00:00Z'),
    })).toThrow(/Knowledge vault not found/);
    expect(existsSync(missing)).toBe(false);
  });

  it('writes a frontmattered note into Sessions/ and returns its rel path', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const rel = distillToVault(vault, {
      sessionName: 'fix graph labels',
      projectName: 'nightyard',
      summary: 'Rebuilt 3D labels with SpriteText.\nCamera flight added.',
      sourceNoteId: 'Notes/Graph ideas.md',
      date: new Date('2026-06-10T10:00:00Z'),
    });
    expect(rel).toBe('Sessions/2026-06-10 fix graph labels.md');
    const content = readFileSync(join(vault, rel), 'utf-8');
    expect(content).toContain('tags: session, nightyard');
    expect(content).toContain('[[Notes/Graph ideas]]');
    expect(content).toContain('SpriteText');
  });

  it('dedupes filename collisions with a numeric suffix', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const o = { sessionName: 'x', projectName: 'p', summary: 's', date: new Date('2026-06-10') };
    distillToVault(vault, o);
    const rel2 = distillToVault(vault, o);
    expect(rel2).toBe('Sessions/2026-06-10 x 2.md');
    expect(existsSync(join(vault, rel2))).toBe(true);
  });

  it('sanitizes projectName with spaces/commas in tags line', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const rel = distillToVault(vault, {
      sessionName: 'test session',
      projectName: 'my proj, awesome',
      summary: 'Test summary',
      date: new Date('2026-06-10'),
    });
    const content = readFileSync(join(vault, rel), 'utf-8');
    expect(existsSync(join(vault, rel))).toBe(true);
    // commas and whitespace runs collapse to single '-'
    expect(content).toContain('tags: session, my-proj-awesome');
  });

  it('collapses newlines in sessionName for filename and heading', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const rel = distillToVault(vault, {
      sessionName: 'fix\nthe\nbug',
      projectName: 'proj',
      summary: 'body',
      date: new Date('2026-06-10'),
    });
    // filename must be single-line safe
    expect(rel).toBe('Sessions/2026-06-10 fix the bug.md');
    const content = readFileSync(join(vault, rel), 'utf-8');
    // heading must also be single-line
    expect(content).toContain('# fix the bug\n');
  });
});

describe('structureSummary', () => {
  it('passes hand-written prose/markdown through unchanged', () => {
    const md = '## What happened\nRebuilt 3D labels with SpriteText.';
    expect(structureSummary(md)).toBe(md);
  });

  it('structures a sleepy transcript into Outcomes and Timeline, dropping noise', () => {
    const raw = [
      'sleepy: orchestrator picked backlog #26: MT briefing',
      'sleepy: dispatching content worker for content draft...',
      '  \u25b8 session started',
      '  \u25b8 (thinking\u2026)',
      '  \u25b8 \u2192 Read(some/file.md)',
      'sleepy: \u2713 content worker produced artifacts/briefing.md (123 lines)',
      'sleepy: finished \u2014 10 iteration(s), 10 ok, 0 failed',
    ].join('\n');
    const out = structureSummary(raw);
    expect(out).toContain('## Outcomes');
    expect(out).toContain('content worker produced artifacts/briefing.md');
    expect(out).toContain('finished \u2014 10 iteration(s), 10 ok, 0 failed');
    expect(out).toContain('## Timeline');
    expect(out).toContain('orchestrator picked backlog #26: MT briefing');
    expect(out).not.toContain('session started');
    expect(out).not.toContain('thinking');
  });

  it('strips ANSI escapes', () => {
    const raw = 'sleepy: \x1b[32m\u2713 worker produced x.md\x1b[0m\n\u25b8 noise';
    const out = structureSummary(raw);
    expect(out).toContain('\u2713 worker produced x.md');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('[32m');
  });

  it('truncates very long timeline entries', () => {
    const raw = 'sleepy: orchestrator picked backlog #1: ' + 'x'.repeat(500);
    const out = structureSummary(raw);
    expect(out).toContain('\u2026');
    expect(out).not.toContain('x'.repeat(400));
  });
});

describe('distillToVault structured output', () => {
  it('writes project field and structures transcript summaries', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const rel = distillToVault(vault, {
      sessionName: 'overnight run',
      projectName: 'demo-app',
      summary: 'sleepy: \u2713 worker produced a.md\n\u25b8 noise line',
      date: new Date('2026-08-26'),
    });
    const content = readFileSync(join(vault, rel), 'utf-8');
    expect(content).toContain('project: demo-app');
    expect(content).toContain('## Outcomes');
    expect(content).not.toContain('noise line\n\u25b8');
  });
});
