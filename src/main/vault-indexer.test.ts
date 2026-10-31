import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseNote, scanVault, isInsideVault, normalizeVaultPath, isUsableVault } from './vault-indexer';

describe('normalizeVaultPath', () => {
  const HOME = '/Users/testuser';

  it('returns default path for empty string', () => {
    expect(normalizeVaultPath('', HOME)).toBe(join(HOME, 'ObsidianVault'));
  });

  it('returns default path for whitespace-only input', () => {
    expect(normalizeVaultPath('   ', HOME)).toBe(join(HOME, 'ObsidianVault'));
  });

  it('expands a Windows-style ~\\ prefix too', () => {
    expect(normalizeVaultPath('~\\Vault', HOME)).toBe(join(HOME, 'Vault'));
  });

  it('expands ~/... to an absolute path', () => {
    expect(normalizeVaultPath('~/MyVault', HOME)).toBe(join(HOME, 'MyVault'));
  });

  it('expands nested ~/... paths', () => {
    expect(normalizeVaultPath('~/notes/vault', HOME)).toBe(join(HOME, 'notes', 'vault'));
  });

  it('returns absolute paths unchanged', () => {
    expect(normalizeVaultPath('/absolute/vault', HOME)).toBe('/absolute/vault');
  });

  it('trims surrounding whitespace before processing', () => {
    expect(normalizeVaultPath('  ~/MyVault  ', HOME)).toBe(join(HOME, 'MyVault'));
  });

  it('treats bare ~ as homedir', () => {
    expect(normalizeVaultPath('~', HOME)).toBe(HOME);
  });
});

describe('isInsideVault', () => {
  it('rejects everything when no vault is configured (never falls back to the cwd)', () => {
    expect(isInsideVault('', 'package.json')).toBe(false);
  });

  it('accepts a normal relative path', () => {
    expect(isInsideVault('/vault', 'Notes/A.md')).toBe(true);
  });

  it('rejects a .. traversal that escapes root', () => {
    expect(isInsideVault('/vault', '../secret.txt')).toBe(false);
  });

  it('rejects an absolute path that is outside root', () => {
    expect(isInsideVault('/vault', '/etc/passwd')).toBe(false);
  });

  it('rejects a prefix-trick sibling directory (/vault-evil vs /vault)', () => {
    expect(isInsideVault('/vault', '../vault-evil/note.md')).toBe(false);
  });

  it('tolerates trailing separator on the vault root', () => {
    expect(isInsideVault('/vault/', 'Notes/A.md')).toBe(true);
  });
});

describe('parseNote', () => {
  it('extracts wikilinks, tags, title and frontmatter', () => {
    const md = `---\ntags: venture, ideas\n---\n# Roadmap\nSee [[Meta Campaign]] and [[ads/Launch|Launch]]. #marketing #q3-goals\n`;
    const note = parseNote('Notes/Roadmap.md', md);
    expect(note.id).toBe('Notes/Roadmap.md');
    expect(note.title).toBe('Roadmap');
    expect(note.wikilinks).toEqual(['Meta Campaign', 'ads/Launch']);
    expect(note.tags).toEqual(expect.arrayContaining(['venture', 'ideas', 'marketing', 'q3-goals']));
    expect(note.folder).toBe('Notes');
  });

  it('falls back to filename for title and handles no links', () => {
    const note = parseNote('inbox/raw idea.md', 'just text, no links');
    expect(note.title).toBe('raw idea');
    expect(note.wikilinks).toEqual([]);
  });

  it('ignores wikilinks inside code fences', () => {
    const note = parseNote('a.md', '```\n[[NotALink]]\n```\n[[RealLink]]');
    expect(note.wikilinks).toEqual(['RealLink']);
  });

  it('does not over-strip when a frontmatter value contains ---', () => {
    const md = `---\nurl: https://x.com/a---b\ntags: real\n---\n# T\n[[Link]]`;
    const note = parseNote('a.md', md);
    expect(note.tags).toContain('real');
    expect(note.wikilinks).toEqual(['Link']);
    expect(note.title).toBe('T');
  });

  it('parses YAML inline-array tags', () => {
    const note = parseNote('a.md', `---\ntags: [venture, ideas]\n---\nx`);
    expect(note.tags).toEqual(expect.arrayContaining(['venture', 'ideas']));
    expect(note.tags.join()).not.toContain('[');
  });

  it('dedupes repeated wikilinks and tags', () => {
    const note = parseNote('a.md', '[[X]] [[X]] #t #t');
    expect(note.wikilinks).toEqual(['X']);
    expect(note.tags).toEqual(['t']);
  });

  it('root-level note has empty folder', () => {
    expect(parseNote('root.md', 'x').folder).toBe('');
  });
});

describe('scanVault', () => {
  it('builds notes + resolved wiki links, skipping dot-dirs and attachments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    mkdirSync(join(dir, 'Notes'), { recursive: true });
    mkdirSync(join(dir, '.obsidian'), { recursive: true });
    mkdirSync(join(dir, '_attachments'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'A.md'), 'links to [[B]] and [[Missing]]');
    writeFileSync(join(dir, 'B.md'), '#shared-tag');
    writeFileSync(join(dir, '.obsidian', 'skip.md'), 'x');
    writeFileSync(join(dir, '_attachments', 'img.png'), 'x');

    const g = scanVault(dir);
    expect(g.notes.map((n) => n.id).sort()).toEqual(['B.md', 'Notes/A.md']);
    expect(g.links).toContainEqual({ source: 'Notes/A.md', target: 'B.md', type: 'wiki' });
    expect(g.links.filter((l) => l.type === 'wiki')).toHaveLength(1);
  });

  it('filename resolution beats another note\'s title (both readdir orders)', () => {
    for (const shadowName of ['AAA-shadow.md', 'ZZZ-shadow.md']) {
      const dir = mkdtempSync(join(tmpdir(), 'vault-'));
      mkdirSync(join(dir, 'Work'), { recursive: true });
      writeFileSync(join(dir, shadowName), '# Projects\nshadow note');
      writeFileSync(join(dir, 'Work', 'Projects.md'), 'target');
      writeFileSync(join(dir, 'src.md'), '[[Projects]]');
      const g = scanVault(dir);
      expect(g.links).toContainEqual({ source: 'src.md', target: 'Work/Projects.md', type: 'wiki' });
    }
  });

  it('ambiguous filenames do not resolve, exact path still does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    mkdirSync(join(dir, 'X'), { recursive: true });
    mkdirSync(join(dir, 'Y'), { recursive: true });
    writeFileSync(join(dir, 'X', 'B.md'), 'x');
    writeFileSync(join(dir, 'Y', 'B.md'), 'y');
    writeFileSync(join(dir, 'src.md'), '[[B]] and [[X/B]]');
    const g = scanVault(dir);
    const wiki = g.links.filter((l) => l.type === 'wiki');
    expect(wiki).toEqual([{ source: 'src.md', target: 'X/B.md', type: 'wiki' }]);
  });

  it('skips unreadable files instead of failing the scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    writeFileSync(join(dir, 'good.md'), 'ok');
    writeFileSync(join(dir, 'bad.md'), 'x');
    chmodSync(join(dir, 'bad.md'), 0o000);
    const g = scanVault(dir);
    expect(g.notes.map((n) => n.id)).toEqual(['good.md']);
    chmodSync(join(dir, 'bad.md'), 0o644);
  });

  it('resolves wikilinks with .md extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    writeFileSync(join(dir, 'B.md'), 'target');
    writeFileSync(join(dir, 'src.md'), '[[B.md]]');
    const g = scanVault(dir);
    expect(g.links).toContainEqual({ source: 'src.md', target: 'B.md', type: 'wiki' });
  });
});

describe('parseNote frontmatter title', () => {
  it('prefers frontmatter title over H1 and filename', () => {
    const md = `---\ntitle: Macro Narrative Agent\ntags: [session-summary]\n---\n# something else\nbody`;
    expect(parseNote('Sessions/x.md', md).title).toBe('Macro Narrative Agent');
  });

  it('strips surrounding quotes from frontmatter title', () => {
    const md = `---\ntitle: "Quoted Title"\n---\nbody`;
    expect(parseNote('a.md', md).title).toBe('Quoted Title');
  });

  it('empty frontmatter title falls through to H1', () => {
    const md = `---\ntitle:\n---\n# Real Heading\nbody`;
    expect(parseNote('a.md', md).title).toBe('Real Heading');
  });
});

describe('scanVault _archive exclusion', () => {
  it('skips notes under _archive/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    writeFileSync(join(dir, 'live.md'), '# Live note');
    mkdirSync(join(dir, '_archive', 'Sessions'), { recursive: true });
    writeFileSync(join(dir, '_archive', 'old.md'), '# Old note');
    writeFileSync(join(dir, '_archive', 'Sessions', 'dump.md'), '# Session dump');
    const g = scanVault(dir);
    expect(g.notes.map((n) => n.id)).toEqual(['live.md']);
  });
});

describe('isUsableVault', () => {
  it('is false for an unconfigured, missing or non-directory path', () => {
    expect(isUsableVault('')).toBe(false);
    expect(isUsableVault('/definitely/not/a/vault/here')).toBe(false);
    expect(isUsableVault(__filename)).toBe(false);
  });
  it('is true for an existing directory', () => {
    expect(isUsableVault(__dirname)).toBe(true);
  });
});
