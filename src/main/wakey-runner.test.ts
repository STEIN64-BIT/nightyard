import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { superviseOnce, cancelSupervision, buildUserPrompt } from './wakey-runner';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./pty-manager', () => ({ getFullPath: () => '/usr/local/bin' }));
vi.mock('./providers/resolve-binary', () => ({ resolveBinary: () => '/usr/local/bin/claude' }));

describe('buildUserPrompt', () => {
  it('includes context sections when provided', () => {
    const result = buildUserPrompt({
      transcript: 'USER: hello\nASSISTANT: hi',
      direction: 'build the parser',
      recentPrompts: ['run tests', 'check lint'],
      boardContext: 'Backlog: "Fix bug" / Active: "Write tests"',
      cwd: '/home/user/project',
    });
    // cwd framing line appears first
    expect(result).toContain('Decide what the user should type next in this Claude Code session at /home/user/project.');
    // direction block with anti-premature-STOP sentence
    expect(result).toContain('USER DIRECTION (highest priority): build the parser');
    expect(result).toContain('then STOP when it is complete');
    expect(result).toContain('Bias every next action toward this direction.');
    // kanban and recent steers
    expect(result).toContain('KANBAN BOARD (project priorities):');
    expect(result).toContain('Backlog: "Fix bug"');
    expect(result).toContain('do NOT repeat these or trivially rephrase them');
    expect(result).toContain('1. run tests');
    expect(result).toContain('2. check lint');
    // transcript
    expect(result).toContain('RECENT TRANSCRIPT:');
    expect(result).toContain('USER: hello');
    // instruction tail always present
    expect(result).toContain('Output JUST the literal text the user should type.');
    expect(result).toContain('DO NOT output bare "continue"');
    expect(result).toContain('Reply with STOP only if the goal is genuinely complete');
    // tail is the last section
    const tailIdx = result.lastIndexOf('Output JUST the literal text');
    const transcriptIdx = result.indexOf('RECENT TRANSCRIPT:');
    expect(tailIdx).toBeGreaterThan(transcriptIdx);
  });

  it('omits context sections cleanly when absent', () => {
    const result = buildUserPrompt({ transcript: 'USER: hello' });
    expect(result).not.toMatch(/do NOT repeat/i);
    expect(result).not.toContain('KANBAN');
    expect(result).not.toContain('USER DIRECTION');
    expect(result).not.toContain('Decide what the user should type next in this Claude Code session at');
    expect(result).toContain('RECENT TRANSCRIPT:');
    expect(result).toContain('USER: hello');
    // instruction tail is always present even without optional fields
    expect(result).toContain('Output JUST the literal text the user should type.');
    expect(result).toContain('DO NOT output bare "continue"');
    expect(result).toContain('Reply with STOP only if the goal is genuinely complete');
  });
});

describe('wakey-runner.superviseOnce', () => {
  let mockChild: any;
  let spawnMock: any;
  beforeEach(async () => {
    vi.useFakeTimers();
    spawnMock = (await import('node:child_process')).spawn;
    mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      pid: 99,
    };
    // The module-level vi.fn() persists across tests in this file; without this
    // an assertion on `mock.calls[0]` would silently read a PREVIOUS test's spawn.
    spawnMock.mockClear();
    spawnMock.mockReturnValue(mockChild);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes claude with the supervisor prompt and resolves with stdout', async () => {
    const promise = superviseOnce({ cwd: '/p', sessionId: 'sid', systemPrompt: 'sys', userPrompt: 'usr' });
    const stdoutHandler = mockChild.stdout.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
    const exitHandler = mockChild.on.mock.calls.find((c: any[]) => c[0] === 'close')[1];
    stdoutHandler(Buffer.from('continue'));
    exitHandler(0);
    const result = await promise;
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      expect.arrayContaining(['-p', '--append-system-prompt', 'sys', '--output-format', 'text']),
      expect.objectContaining({ cwd: '/p' }),
    );
    expect(mockChild.stdin.write).toHaveBeenCalledWith('usr');
    expect(result).toBe('continue');
  });

  it('cancels the supervisor immediately when stopped', async () => {
    const promise = superviseOnce({ cwd: '/p', sessionId: 'sid', systemPrompt: 's', userPrompt: 'u' });
    const caught = promise.catch(e => e);
    cancelSupervision('sid');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect((await caught).message).toContain('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('strips ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN from the spawn env but keeps the augmented PATH', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-should-not-leak';
    try {
      const promise = superviseOnce({ cwd: '/p', sessionId: 'sid', systemPrompt: 's', userPrompt: 'u' });
      const exitHandler = mockChild.on.mock.calls.find((c: any[]) => c[0] === 'close')[1];
      exitHandler(0);
      await promise;
      const env = spawnMock.mock.calls[0][2].env;
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      expect(env.PATH).toBe('/usr/local/bin');
      // the caller's own environment is untouched
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-should-not-leak');
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
    }
  });

  it('rejects when claude exits non-zero', async () => {
    const promise = superviseOnce({ cwd: '/p', sessionId: 'sid', systemPrompt: 's', userPrompt: 'u' });
    const exitHandler = mockChild.on.mock.calls.find((c: any[]) => c[0] === 'close')[1];
    exitHandler(1);
    await expect(promise).rejects.toThrow();
  });

  it('SIGKILLs child and rejects with timeout error when 90s elapses without exit', async () => {
    const promise = superviseOnce({ cwd: '/p', sessionId: 'sid', systemPrompt: 's', userPrompt: 'u' });
    // Attach a catch early so the rejection is not "unhandled" while we advance timers
    const caught = promise.catch((e: Error) => e);
    // Advance fake timers past the 90s threshold
    await vi.advanceTimersByTimeAsync(90_001);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Wakey: supervisor timed out');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not reject with timeout if process exits before 90s', async () => {
    const promise = superviseOnce({ cwd: '/p', sessionId: 'sid', systemPrompt: 's', userPrompt: 'u' });
    const stdoutHandler = mockChild.stdout.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
    const exitHandler = mockChild.on.mock.calls.find((c: any[]) => c[0] === 'close')[1];
    stdoutHandler(Buffer.from('ok'));
    exitHandler(0);
    await vi.advanceTimersByTimeAsync(90_001);
    const result = await promise;
    expect(result).toBe('ok');
    expect(mockChild.kill).not.toHaveBeenCalled();
  });
});
