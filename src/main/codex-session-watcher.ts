import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { STATUS_DIR } from './hook-status';
import { codexHomeDir } from './codex-homes';

/**
 * Codex CLI has no hook system to report session IDs back to the host app.
 * Instead, we tail <CODEX_HOME>/history.jsonl for new entries and extract the
 * session_id, then write a .sessionid file so hook-status picks it up.
 *
 * One tail per Codex home: a session spawned under ~/.codex-personal must be
 * matched against that home's history, never against ~/.codex.
 */

interface HomeWatch {
  home: string;
  historyPath: string;
  watcher: fs.FSWatcher | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  lastSize: number;
  /** UI session ID → registration timestamp (FIFO assignment) */
  pending: Map<string, number>;
}

const watches = new Map<string, HomeWatch>();
const assignedCodexIds = new Set<string>();

function getWatch(home: string): HomeWatch {
  let w = watches.get(home);
  if (!w) {
    w = {
      home,
      historyPath: path.join(home, 'history.jsonl'),
      watcher: null,
      pollInterval: null,
      lastSize: 0,
      pending: new Map(),
    };
    watches.set(home, w);
  }
  return w;
}

function readNewEntries(w: HomeWatch): void {
  if (w.pending.size === 0) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(w.historyPath);
  } catch {
    return;
  }

  if (stat.size <= w.lastSize) return;

  let fd: number | null = null;
  try {
    fd = fs.openSync(w.historyPath, 'r');
    const buf = Buffer.alloc(stat.size - w.lastSize);
    fs.readSync(fd, buf, 0, buf.length, w.lastSize);
    w.lastSize = stat.size;

    const lines = buf.toString('utf-8').trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const codexSessionId: string | undefined = entry.session_id;
        if (!codexSessionId || assignedCodexIds.has(codexSessionId)) continue;

        // Assign to the oldest pending UI session on this home
        let oldestId: string | null = null;
        let oldestTime = Infinity;
        for (const [uiId, addedAt] of w.pending) {
          if (addedAt < oldestTime) {
            oldestTime = addedAt;
            oldestId = uiId;
          }
        }

        if (oldestId) {
          assignedCodexIds.add(codexSessionId);
          w.pending.delete(oldestId);

          fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
          fs.writeFileSync(
            path.join(STATUS_DIR, `${oldestId}.sessionid`),
            codexSessionId
          );
          break;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export function registerPendingCodexSession(sessionId: string, home: string = codexHomeDir()): void {
  const w = getWatch(home);
  // Only advance lastSize when the first session registers, so we don't skip
  // entries that arrived between multiple rapid registrations
  if (w.pending.size === 0) {
    try {
      w.lastSize = fs.statSync(w.historyPath).size;
    } catch {
      w.lastSize = 0;
    }
  }

  w.pending.set(sessionId, Date.now());
}

export function unregisterCodexSession(sessionId: string): void {
  for (const w of watches.values()) w.pending.delete(sessionId);
}

export function startCodexSessionWatcher(win: BrowserWindow, home: string = codexHomeDir()): void {
  const w = getWatch(home);
  if (w.watcher || w.pollInterval) return;

  try {
    fs.mkdirSync(home, { recursive: true });
    w.watcher = fs.watch(home, (_event, filename) => {
      if (filename === 'history.jsonl' && w.pending.size > 0) {
        readNewEntries(w);
      }
    });
  } catch {
    // Directory might not exist; fall through to polling
  }

  // Polling fallback — fs.watch can miss events on some systems
  w.pollInterval = setInterval(() => {
    if (w.pending.size > 0 && !win.isDestroyed()) {
      readNewEntries(w);
    }
  }, 2000);
}

export function stopCodexSessionWatcher(): void {
  for (const w of watches.values()) {
    if (w.watcher) w.watcher.close();
    if (w.pollInterval) clearInterval(w.pollInterval);
  }
  watches.clear();
  assignedCodexIds.clear();
}
