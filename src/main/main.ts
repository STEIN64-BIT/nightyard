import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron';
import * as path from 'path';
import { registerIpcHandlers, resetHookWatcher } from './ipc-handlers';
import { killAllPtys } from './pty-manager';
import { flushState, loadState } from './store';
import { createAppMenu } from './menu';
import { restartAndResync } from './hook-status';
import { initProviders, getAllProviders } from './providers/registry';
import { initAutoUpdater } from './auto-updater';
import { stopGitWatcher } from './git-watcher';
import { checkPythonAvailable } from './prerequisites';
import { isMac } from './platform';
import { isCloseConfirmed, setCloseConfirmed } from './close-state';
import { applyGpuStabilityFlags } from './gpu-flags';
import { initWindowManager, restoreHostWindows, setPrimary, setAppQuitting, windowPreferences } from './window-manager';
import { broadcastToAllWindows } from './broadcast';
import { stopAllCounsels } from './counsel/ipc';
import { disposeWakeyCore } from './wakey/wakey-core';

// Must run before app `ready` / the first GPU-process launch.
applyGpuStabilityFlags(app.commandLine);

let mainWindow: BrowserWindow | null = null;

function requestConfirmClose(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:confirmClose');
  } else {
    setCloseConfirmed(true);
    app.quit();
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Nightyard',
    icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
    backgroundColor: '#000000',
    webPreferences: windowPreferences('primary'),
  });
  setPrimary(mainWindow);

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  // In a dev checkout, open devtools so console errors are visible. Never in the packaged app.
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Open external links in default browser instead of inside the app
  const isHttpUrl = (url: string) => url.startsWith('http://') || url.startsWith('https://');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isCloseConfirmed()) {
      event.preventDefault();
      requestConfirmClose();
      return;
    }
    flushState();
  });

  mainWindow.on('closed', () => {
    killAllPtys();
    resetHookWatcher();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  initProviders();

  const providers = getAllProviders();
  const missing = providers.filter(p => !p.validatePrerequisites());
  for (const p of missing) {
    console.warn(`Provider "${p.meta.displayName}" not available`);
  }
  if (missing.length === providers.length) {
    const bullets = providers.map(p => `  • ${p.meta.displayName}`).join('\n');
    dialog.showErrorBox(
      'Nightyard — No CLI Provider Found',
      `Nightyard needs at least one supported CLI provider installed to run.\n\n` +
        `Install one of the following, then restart Nightyard:\n\n${bullets}`,
    );
    app.quit();
    return;
  }

  registerIpcHandlers();
  initWindowManager();
  const state = loadState();
  createAppMenu(state.preferences?.debugMode ?? false);
  createWindow();
  restoreHostWindows();

  // Warn if Python is missing on Windows (hooks depend on it)
  const pythonWarning = checkPythonAvailable();
  if (pythonWarning) {
    console.warn(pythonWarning);
    dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Nightyard — Python Not Found',
      message: pythonWarning,
    });
  }

  // Install hooks and status scripts for available providers (after window creation so dialogs can attach)
  for (const provider of getAllProviders()) {
    if (provider.validatePrerequisites()) {
      await provider.installHooks(mainWindow);
      provider.installStatusScripts();
    }
  }

  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        restartAndResync(win);
      }
    }
  });

  powerMonitor.on('resume', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      restartAndResync(win);
    }
  });
});

app.on('before-quit', (event) => {
  if (!isCloseConfirmed()) {
    event.preventDefault();
    requestConfirmClose();
    return;
  }
  setAppQuitting(); // host windows must not dump sessions back to primary mid-quit
  flushState();
  broadcastToAllWindows('app:quitting');
  // Flushes the wakey runs so active supervisions resume on the next launch.
  void disposeWakeyCore();
  killAllPtys();
  stopAllCounsels();
  stopGitWatcher();
  // Cleanup all providers
  for (const provider of getAllProviders()) {
    provider.cleanup();
  }
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});
