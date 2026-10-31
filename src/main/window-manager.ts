import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as crypto from 'crypto';
import { WindowRegistry } from './window-registry';
import { broadcastToAllWindows } from './broadcast';
import { loadState, saveState, flushState, getLastState } from './store';
import { PRIMARY_WINDOW_ID, type WindowBounds } from '../shared/window-types';

const registry = new WindowRegistry();
const hostWindows = new Map<string, BrowserWindow>();
let primaryWindow: BrowserWindow | null = null;
let appQuitting = false;
const closingEmptyHosts = new Set<string>();

export function getRegistry(): WindowRegistry { return registry; }
export function getPrimaryWindow(): BrowserWindow | null { return primaryWindow; }
export function setPrimary(win: BrowserWindow): void { primaryWindow = win; }
export function setAppQuitting(): void { appQuitting = true; }

export function windowPreferences(windowId: string): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '..', '..', 'preload', 'preload', 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false, // needed for node-pty IPC
    webviewTag: true, // needed for browser-tab sessions
    additionalArguments: [`--vy-window-id=${windowId}`],
  };
}

/** Merge registry into the freshest known state and save. */
export function persistRegistry(): void {
  const state = getLastState() ?? loadState();
  state.windows = registry.serialize();
  saveState(state);
}

function notifyChanged(): void {
  broadcastToAllWindows('windows:changed', registry.snapshot());
  persistRegistry();
}

export function createHostWindow(id: string, bounds: WindowBounds): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 500,
    minHeight: 350,
    title: 'Nightyard',
    backgroundColor: '#000000',
    webPreferences: windowPreferences(id),
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  hostWindows.set(id, win);

  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        registry.setBounds(id, win.getBounds());
        persistRegistry();
      }
    }, 500);
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  win.on('close', () => {
    // Closing a host window returns its tabs to the primary — never kills sessions.
    if (appQuitting || closingEmptyHosts.has(id)) return;
    registry.removeHost(id);
    notifyChanged();
  });
  win.on('closed', () => {
    hostWindows.delete(id);
    closingEmptyHosts.delete(id);
  });
  return win;
}

function closeHostIfEmpty(windowId: string): void {
  if (windowId === PRIMARY_WINDOW_ID) return;
  if (!registry.hasHost(windowId)) return;
  if (registry.sessionsOf(windowId).length > 0) return;
  registry.removeHost(windowId);
  const win = hostWindows.get(windowId);
  if (win && !win.isDestroyed()) {
    closingEmptyHosts.add(windowId);
    win.close();
  }
}

function windowFor(windowId: string): BrowserWindow | null {
  if (windowId === PRIMARY_WINDOW_ID) return primaryWindow;
  return hostWindows.get(windowId) ?? null;
}

function doTearOff(sessionId: string, screenX: number, screenY: number): void {
  const from = registry.ownerOf(sessionId);
  const bounds: WindowBounds = { x: Math.round(screenX) - 80, y: Math.round(screenY) - 20, width: 980, height: 640 };
  const id = `host-${crypto.randomUUID()}`;
  flushState(); // the new host bootstraps appState from disk — make it fresh
  registry.createHost(id, bounds);
  registry.assign(sessionId, id);
  registry.setActiveSession(id, sessionId);
  windowFor(from)?.webContents.send('windows:sessionReleased', sessionId);
  createHostWindow(id, bounds);
  closeHostIfEmpty(from);
  notifyChanged();
}

export function initWindowManager(): void {
  registry.loadFrom(loadState().windows);

  ipcMain.handle('windows:getSnapshot', () => registry.snapshot());

  ipcMain.handle('windows:tearOffAt', (_e, sessionId: string, x: number, y: number) => {
    doTearOff(sessionId, x, y);
  });

  ipcMain.handle('windows:tearOffOutside', (_e, sessionId: string, x: number, y: number) => {
    const insideSome = BrowserWindow.getAllWindows().some((w) => {
      if (w.isDestroyed()) return false;
      const b = w.getBounds();
      return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    });
    if (insideSome) return; // ESC-cancel, or a drop another window already handled
    doTearOff(sessionId, x, y);
  });

  ipcMain.handle('windows:transfer', (_e, sessionId: string, targetWindowId: string, index: number) => {
    const from = registry.ownerOf(sessionId);
    if (targetWindowId === PRIMARY_WINDOW_ID) {
      if (from === PRIMARY_WINDOW_ID) return; // in-primary reorder is renderer-side
      registry.release(sessionId);
    } else {
      if (!registry.hasHost(targetWindowId)) return;
      registry.assign(sessionId, targetWindowId, index);
      registry.setActiveSession(targetWindowId, sessionId);
    }
    if (from !== targetWindowId) {
      windowFor(from)?.webContents.send('windows:sessionReleased', sessionId);
      windowFor(targetWindowId)?.webContents.send('windows:sessionAssigned', sessionId, index);
    }
    closeHostIfEmpty(from);
    notifyChanged();
  });

  ipcMain.handle('windows:moveToNewWindow', (_e, sessionId: string) => {
    const owner = windowFor(registry.ownerOf(sessionId));
    const b = owner && !owner.isDestroyed() ? owner.getBounds() : { x: 120, y: 120, width: 980, height: 640 };
    doTearOff(sessionId, b.x + 140, b.y + 80);
  });

  ipcMain.on('windows:setActiveSession', (_e, windowId: string, sessionId: string | null) => {
    registry.setActiveSession(windowId, sessionId);
    persistRegistry();
  });

  ipcMain.on('windows:releaseSession', (_e, sessionId: string) => {
    const from = registry.ownerOf(sessionId);
    if (from === PRIMARY_WINDOW_ID) return;
    registry.release(sessionId);
    closeHostIfEmpty(from);
    notifyChanged();
  });
}

export function restoreHostWindows(): void {
  // Prune against sessions that actually exist, then reopen persisted hosts.
  const state = loadState();
  const valid = new Set<string>();
  for (const p of state.projects) for (const s of p.sessions) valid.add(s.id);
  registry.pruneToSessions(valid);
  for (const empty of registry.emptyHosts()) registry.removeHost(empty);
  for (const rec of registry.serialize()) createHostWindow(rec.id, rec.bounds);
  persistRegistry();
}
