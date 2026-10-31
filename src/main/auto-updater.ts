import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY_MS = 10_000; // 10 seconds

function sendToRenderer(channel: string, payload: Record<string, unknown>): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * electron-builder only writes `resources/app-update.yml` when the build has a
 * publish target. Nightyard ships with `build.publish: null`, so a build made
 * from it has no update feed — and must never fall back to checking (and
 * silently installing on quit) some other release feed, which would replace
 * the app with someone else's build.
 */
function hasUpdateConfig(): boolean {
  const resources = process.resourcesPath;
  return !resources || fs.existsSync(path.join(resources, 'app-update.yml'));
}

export function checkForUpdates(): void {
  if (!hasUpdateConfig()) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  // No update feed in this build (see hasUpdateConfig) → the updater stays off.
  if (!hasUpdateConfig()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('update:available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update:download-progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    sendToRenderer('update:error', { message: err?.message ?? 'Unknown error' });
  });

  // Check after startup delay, then periodically
  setTimeout(checkForUpdates, STARTUP_DELAY_MS);
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}
