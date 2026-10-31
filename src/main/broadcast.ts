import { BrowserWindow } from 'electron';

/** Send a channel to every open window (session-scoped events are window-agnostic). */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}
