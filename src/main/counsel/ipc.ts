import { randomUUID } from 'crypto';
import type { IpcMain } from 'electron';
import type { CounselStartConfig } from '../../shared/types';
import { broadcastToAllWindows } from '../broadcast';
import { validateBinaryExists } from '../providers/resolve-binary';
import { createCliRunner } from './runner';
import { launchCounsel, type CounselHandle } from './orchestrator';

const active = new Map<string, CounselHandle>();

export function registerCounselIpc(ipcMain: IpcMain): void {
  ipcMain.handle('counsel:start', (_event, config: Omit<CounselStartConfig, 'counselId'>) => {
    const counselId = randomUUID();
    const handle = launchCounsel(
      { ...config, counselId },
      { runner: createCliRunner(), emit: (e) => broadcastToAllWindows('counsel:event', e) },
    );
    active.set(counselId, handle);
    void handle.result.catch(() => {}).finally(() => active.delete(counselId));
    return counselId;
  });

  ipcMain.handle('counsel:stop', (_event, counselId: string) => {
    active.get(counselId)?.stop();
  });

  ipcMain.handle('counsel:checkEngines', async () => ({
    claude: validateBinaryExists('claude'),
    codex: validateBinaryExists('codex'),
  }));
}

/** Stops every in-flight counsel debate (child CLI processes included). Called
 *  on app quit so debates don't outlive the app as orphaned processes. */
export function stopAllCounsels(): void {
  for (const handle of active.values()) handle.stop();
  active.clear();
}
