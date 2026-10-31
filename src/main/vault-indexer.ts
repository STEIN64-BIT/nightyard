import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatterContent, stripFrontmatter } from './frontmatter';
import type { VaultGraph, VaultLink, VaultNote } from '../shared/types';

/**
 * Normalise a user-supplied vault path.
 *
 * - Trims whitespace.
 * - Empty / whitespace-only input → `<homedir>/ObsidianVault` (the default).
 *   Any folder of Markdown notes works (Preferences → Knowledge vault path);
 *   a default that does not exist simply yields an empty graph.
 * - `~/…` (or `~\…`) prefix is expanded using the supplied `homeDir` argument
 *   so the function stays pure / testable without touching `os.homedir()`.
 * - Absolute paths are returned unchanged (after trimming).
 */
export function normalizeVaultPath(input: string, homeDir: string = homedir()): string {
  const trimmed = input.trim();
  if (!trimmed) return join(homeDir, 'ObsidianVault');
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homeDir, trimmed.slice(2));
  return trimmed;
}

/** True when `root` is a configured, existing directory that can be scanned. */
export function isUsableVault(root: string): boolean {
  if (!root) return false;
  try { return statSync(root).isDirectory(); } catch { return false; }
}

/**
 * Returns true if `rel` resolves to a path strictly inside `root` (or equal to root).
 * Uses resolve+sep so that a prefix like /vault-evil cannot escape /vault.
 */
export function isInsideVault(root: string, rel: string): boolean {
  if (!root) return false; // no vault configured — never fall back to the cwd
  const normRoot = resolve(root);
  const abs = resolve(normRoot, rel);
  return abs === normRoot || abs.startsWith(normRoot + sep);
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const INLINE_TAG = /(^|\s)#([a-zA-Z0-9][\w/-]*)/g;
const H1 = /^#\s+(.+)$/m;

function stripCodeFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

export function parseNote(relPath: string, content: string, mtimeMs = 0): VaultNote {
  const fm = parseFrontmatterContent(content);
  const body = stripCodeFences(stripFrontmatter(content));
  const fmTags = (fm.tags ?? '').replace(/[[\]'"]/g, '').split(/[,\s]+/).filter(Boolean);
  const inlineTags = [...body.matchAll(INLINE_TAG)].map((m) => m[2]);
  const wikilinks = [...body.matchAll(WIKILINK)].map((m) => m[1].trim());
  const fileName = relPath.split('/').pop()!.replace(/\.md$/, '');
  const folder = relPath.includes('/') ? relPath.split('/')[0] : '';

  const fmTitle = (fm.title ?? '').replace(/^["']|["']$/g, '').trim();

  return {
    id: relPath,
    title: fmTitle || (H1.exec(body)?.[1].trim() ?? fileName),
    folder,
    tags: [...new Set([...fmTags, ...inlineTags])],
    wikilinks: [...new Set(wikilinks)],
    mtimeMs,
  };
}

const SKIP_DIRS = new Set(['.obsidian', '_attachments', '.git', '.trash', 'node_modules', '_archive']);

function* walkMd(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* walkMd(join(dir, e.name));
    } else if (e.name.endsWith('.md')) {
      yield join(dir, e.name);
    }
  }
}

export function scanVault(root: string): VaultGraph {
  const notes: VaultNote[] = [];
  for (const abs of walkMd(root)) {
    const rel = relative(root, abs).split('\\').join('/');
    try {
      notes.push(parseNote(rel, readFileSync(abs, 'utf-8'), statSync(abs).mtimeMs));
    } catch (err) {
      console.warn('vault: skipping unreadable file', rel, err);
    }
  }
  // Resolve [[target]] the way Obsidian does: by exact path, then by unique filename, then by unique title.
  const byPath = new Map(notes.map((n) => [n.id.replace(/\.md$/, '').toLowerCase(), n.id]));
  const byFilename = new Map<string, string | null>(); // null = ambiguous
  const byTitle = new Map<string, string | null>(); // null = ambiguous

  for (const n of notes) {
    // Build byFilename: filename (minus .md, lowercased) -> id, null if ambiguous
    const filenameKey = n.id.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
    byFilename.set(filenameKey, byFilename.has(filenameKey) ? null : n.id);
  }

  for (const n of notes) {
    // Build byTitle: title (lowercased) -> id, null if ambiguous
    const titleKey = n.title.toLowerCase();
    byTitle.set(titleKey, byTitle.has(titleKey) ? null : n.id);
  }

  function resolve(key: string): string | null {
    if (byPath.has(key)) return byPath.get(key)!;
    if (byFilename.has(key)) return byFilename.get(key) ?? null; // null if ambiguous — do NOT fall through
    if (byTitle.has(key)) return byTitle.get(key) ?? null;
    return null;
  }

  const links: VaultLink[] = [];
  for (const n of notes) {
    for (const raw of n.wikilinks) {
      const key = raw.replace(/\.md$/i, '').toLowerCase();
      const target = resolve(key);
      if (target && target !== n.id) links.push({ source: n.id, target, type: 'wiki' });
    }
  }
  return { notes, links };
}
