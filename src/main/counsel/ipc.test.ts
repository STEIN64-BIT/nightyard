import { describe, it, expect, vi, beforeEach } from 'vitest';

const launchMock = vi.fn();
const broadcastMock = vi.fn();
vi.mock('./orchestrator', () => ({ launchCounsel: (...a: unknown[]) => launchMock(...a) }));
vi.mock('./runner', () => ({ createCliRunner: () => ({ abortActive: vi.fn() }) }));
vi.mock('../broadcast', () => ({ broadcastToAllWindows: (...a: unknown[]) => broadcastMock(...a) }));
vi.mock('../providers/resolve-binary', () => ({ validateBinaryExists: (n: string) => n === 'claude' }));

import { registerCounselIpc, stopAllCounsels } from './ipc';

function makeIpcMain() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    handlers,
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
  };
}

const config = { projectPath: '/p', prompt: 'q', seats: {}, systemPrompts: {}, style: 'balanced', contextPass: false, maxTurns: 9, minTurnsBeforeStop: 3, moderatorEnabled: true };

describe('counsel ipc', () => {
  beforeEach(() => { launchMock.mockReset(); broadcastMock.mockReset(); });

  it('counsel:start launches with a generated counselId, forwards events, returns the id', async () => {
    launchMock.mockReturnValue({ stop: vi.fn(), result: Promise.resolve({}) });
    const ipc = makeIpcMain();
    registerCounselIpc(ipc as never);
    const id = await ipc.invoke('counsel:start', config);
    expect(typeof id).toBe('string');
    const [launchedConfig, deps] = launchMock.mock.calls[0];
    expect(launchedConfig.counselId).toBe(id);
    deps.emit({ type: 'turn-delta', counselId: id, turnId: 't', chunk: 'x' });
    expect(broadcastMock).toHaveBeenCalledWith('counsel:event', { type: 'turn-delta', counselId: id, turnId: 't', chunk: 'x' });
  });

  it('counsel:stop stops the matching handle and is a no-op for unknown ids', async () => {
    const stop = vi.fn();
    launchMock.mockReturnValue({ stop, result: new Promise(() => {}) });
    const ipc = makeIpcMain();
    registerCounselIpc(ipc as never);
    const id = await ipc.invoke('counsel:start', config);
    await ipc.invoke('counsel:stop', id);
    expect(stop).toHaveBeenCalled();
    await ipc.invoke('counsel:stop', 'nope'); // must not throw
  });

  it('counsel:checkEngines reports binary availability', async () => {
    const ipc = makeIpcMain();
    registerCounselIpc(ipc as never);
    await expect(ipc.invoke('counsel:checkEngines')).resolves.toEqual({ claude: true, codex: false });
  });

  it('stopAllCounsels stops every active handle and clears the map', async () => {
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    const ipc = makeIpcMain();
    registerCounselIpc(ipc as never);

    launchMock.mockReturnValueOnce({ stop: stop1, result: new Promise(() => {}) });
    const id1 = await ipc.invoke('counsel:start', config);
    launchMock.mockReturnValueOnce({ stop: stop2, result: new Promise(() => {}) });
    const id2 = await ipc.invoke('counsel:start', config);

    stopAllCounsels();

    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledTimes(1);

    // The map is cleared, not just stopped-in-place — a later counsel:stop
    // for either id must be a no-op rather than calling stop() again.
    await ipc.invoke('counsel:stop', id1);
    await ipc.invoke('counsel:stop', id2);
    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledTimes(1);
  });

  it('a rejecting result does not crash and still cleans up the handle map', async () => {
    const stop = vi.fn();
    launchMock.mockReturnValue({ stop, result: Promise.reject(new Error('boom')) });
    const ipc = makeIpcMain();
    registerCounselIpc(ipc as never);
    const id = await ipc.invoke('counsel:start', config);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the rejection settle
    await ipc.invoke('counsel:stop', id); // handle already cleaned up — must be a no-op, not a throw
    expect(stop).not.toHaveBeenCalled();
  });
});
