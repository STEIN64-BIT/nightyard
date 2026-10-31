import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSleepy, killSleepy } from './sleepy-runner';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./pty-manager', () => ({
  getFullPath: () => '/usr/local/bin:/usr/bin:/bin',
}));

describe('sleepy-runner', () => {
  let mockChild: any;
  let spawnMock: any;
  beforeEach(async () => {
    vi.useFakeTimers();
    spawnMock = (await import('node:child_process')).spawn;
    // `once` needs to be a real-ish stub: store the callback so tests can fire it.
    const onceCallbacks = new Map<string, () => void>();
    mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      once: vi.fn((event: string, cb: () => void) => { onceCallbacks.set(event, cb); }),
      kill: vi.fn(),
      pid: 12345,
      _fireOnce: (event: string) => onceCallbacks.get(event)?.(),
    };
    spawnMock.mockReturnValue(mockChild);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns node with the sleepy binary path and args', () => {
    const handle = spawnSleepy({
      sleepyBin: '/path/to/sleepy.mjs',
      args: ['go', 'test prompt'],
      cwd: '/project',
      onData: vi.fn(),
      onExit: vi.fn(),
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['/path/to/sleepy.mjs', 'go', 'test prompt'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(handle.pid).toBe(12345);
  });

  it('runs with the given Node command and merges its env (Electron as Node)', () => {
    spawnSleepy({
      sleepyBin: '/app/Resources/sleepy/cli/bin/sleepy.mjs',
      args: ['start'],
      cwd: '/project',
      onData: vi.fn(),
      onExit: vi.fn(),
      node: { command: '/app/MacOS/Nightyard', env: { ELECTRON_RUN_AS_NODE: '1' } },
    });
    const [cmd, args, options] = spawnMock.mock.calls.at(-1);
    expect(cmd).toBe('/app/MacOS/Nightyard');
    expect(args).toEqual(['/app/Resources/sleepy/cli/bin/sleepy.mjs', 'start']);
    expect(options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/local/bin:/usr/bin:/bin' });
  });

  it('killSleepy sends SIGTERM', () => {
    const handle = spawnSleepy({
      sleepyBin: '/x', args: [], cwd: '/p', onData: vi.fn(), onExit: vi.fn(),
    });
    killSleepy(handle);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('killSleepy escalates to SIGKILL after 5s when child ignores SIGTERM', async () => {
    const handle = spawnSleepy({
      sleepyBin: '/x', args: [], cwd: '/p', onData: vi.fn(), onExit: vi.fn(),
    });
    killSleepy(handle);
    // Child has not exited yet — advance past the 5 s grace period.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('killSleepy does NOT send SIGKILL when child exits within 5s', async () => {
    const handle = spawnSleepy({
      sleepyBin: '/x', args: [], cwd: '/p', onData: vi.fn(), onExit: vi.fn(),
    });
    killSleepy(handle);
    // Simulate the child exiting quickly after SIGTERM.
    mockChild._fireOnce('exit');
    await vi.advanceTimersByTimeAsync(5_001);
    const killCalls = (mockChild.kill as ReturnType<typeof vi.fn>).mock.calls;
    expect(killCalls.every((c: string[]) => c[0] !== 'SIGKILL')).toBe(true);
  });

  it('forwards stdout to onData', () => {
    const onData = vi.fn();
    spawnSleepy({ sleepyBin: '/x', args: [], cwd: '/p', onData, onExit: vi.fn() });
    const stdoutHandler = mockChild.stdout.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
    stdoutHandler(Buffer.from('hello'));
    expect(onData).toHaveBeenCalledWith('hello', 'stdout');
  });
});
