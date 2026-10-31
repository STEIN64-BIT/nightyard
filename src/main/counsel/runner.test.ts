import { describe, it, expect, vi, beforeEach } from 'vitest';

const oneShotMock = vi.fn();
const streamingMock = vi.fn();
vi.mock('../providers-oneshot/one-shot', () => ({ spawnOneShot: (...a: unknown[]) => oneShotMock(...a) }));
vi.mock('../providers-oneshot/streaming-spawn', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../providers-oneshot/streaming-spawn')>();
  return { ...orig, spawnStreaming: (...a: unknown[]) => streamingMock(...a) };
});
vi.mock('../providers/resolve-binary', () => ({ resolveBinary: (name: string) => `/bin/${name}` }));
vi.mock('../pty-manager', () => ({ getFullPath: () => '/mock/login-shell/bin:/usr/bin:/bin' }));

import { createCliRunner, buildClaudeTurnArgs, buildCodexTurnArgs, buildContextPassArgs } from './runner';
import type { CounselSeatConfig } from '../../shared/types';

const claudeSeat: CounselSeatConfig = { memberId: '1', memberName: 'A', memberRole: 'r', providerId: 'claude' };
const codexSeat: CounselSeatConfig = { memberId: '2', memberName: 'B', memberRole: 'r', providerId: 'codex' };

describe('arg builders', () => {
  it('claude turn args carry an optional --model', () => {
    expect(buildClaudeTurnArgs('P', 'Q', 'sonnet')).toEqual([
      '--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--model', 'sonnet', '--append-system-prompt', 'P', 'Q',
    ]);
    expect(buildClaudeTurnArgs('P', 'Q')).not.toContain('--model');
  });
  it('codex turn args carry an optional --model', () => {
    expect(buildCodexTurnArgs('P', 'Q', '/tmp/last.txt', 'gpt-5-mini')).toEqual([
      'exec', '--json', '--output-last-message', '/tmp/last.txt', '--model', 'gpt-5-mini',
      '-c', 'developer_instructions=P', 'Q',
    ]);
    expect(buildCodexTurnArgs('P', 'Q', '/tmp/last.txt')).not.toContain('--model');
  });

  it('claude turn args stream json with the persona system prompt', () => {
    expect(buildClaudeTurnArgs('PERSONA', 'PROMPT')).toEqual([
      '--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--append-system-prompt', 'PERSONA', 'PROMPT',
    ]);
  });
  it('codex turn args use exec json with developer_instructions and last-message file', () => {
    expect(buildCodexTurnArgs('PERSONA', 'PROMPT', '/tmp/last.txt')).toEqual([
      'exec', '--json', '--output-last-message', '/tmp/last.txt',
      '-c', 'developer_instructions=PERSONA', 'PROMPT',
    ]);
  });
});

describe('buildContextPassArgs', () => {
  it('binds allowedTools with = so the variadic flag cannot swallow the prompt', () => {
    // Regression: ['--print', '--allowedTools', 'Read,Grep,Glob', prompt] made the
    // CLI parse the prompt as another tool name -> "Input must be provided" error
    // on every context pass, silently caught upstream (contextBrief always null).
    expect(buildContextPassArgs('THE QUESTION')).toEqual([
      '--print', '--allowedTools=Read,Grep,Glob', 'THE QUESTION',
    ]);
  });
});

describe('createCliRunner', () => {
  beforeEach(() => { oneShotMock.mockReset(); streamingMock.mockReset(); });

  it('every spawn gets a login-shell PATH (codex is an nvm env-node script; app env is launchd PATH)', async () => {
    streamingMock.mockResolvedValue('text');
    oneShotMock.mockResolvedValue('brief');
    const runner = createCliRunner();
    await runner.runTurn(codexSeat, 'sys', 'prompt', () => {});
    await runner.runTurn(claudeSeat, 'sys', 'prompt', () => {});
    await runner.runOneShot('p');
    await runner.runContextPass('p', '/proj');
    for (const call of [...streamingMock.mock.calls, ...oneShotMock.mock.calls]) {
      const opts = call[2] as { env?: NodeJS.ProcessEnv };
      expect(opts.env?.PATH).toBe('/mock/login-shell/bin:/usr/bin:/bin');
    }
  });

  it('runContextPass uses the safe args and the project cwd', async () => {
    oneShotMock.mockResolvedValue('brief');
    const runner = createCliRunner();
    await runner.runContextPass('THE QUESTION', '/my/project');
    const [bin, args, opts] = oneShotMock.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(bin).toBe('/bin/claude');
    expect(args).toEqual(['--print', '--allowedTools=Read,Grep,Glob', 'THE QUESTION']);
    expect(opts.cwd).toBe('/my/project');
  });

  it('runTurn forwards the seat model to the CLI', async () => {
    streamingMock.mockResolvedValue('text');
    const runner = createCliRunner();
    await runner.runTurn({ ...claudeSeat, model: 'sonnet' }, 'sys', 'prompt', () => {});
    const args = streamingMock.mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
  });

  it('runTurn routes claude seats to the claude binary with the claude parser', async () => {
    streamingMock.mockResolvedValue('text');
    const runner = createCliRunner();
    await runner.runTurn(claudeSeat, 'sys', 'prompt', () => {});
    const [binary, args, opts] = streamingMock.mock.calls[0];
    expect(binary).toBe('/bin/claude');
    expect(args).toContain('--append-system-prompt');
    expect(opts.finalText).toBeUndefined();
  });

  it('runTurn routes codex seats to the codex binary with a finalText hook', async () => {
    streamingMock.mockResolvedValue('text');
    const runner = createCliRunner();
    await runner.runTurn(codexSeat, 'sys', 'prompt', () => {});
    const [binary, , opts] = streamingMock.mock.calls[0];
    expect(binary).toBe('/bin/codex');
    expect(typeof opts.finalText).toBe('function');
  });

  it('runOneShot passes the model flag only when given', async () => {
    oneShotMock.mockResolvedValue('out');
    const runner = createCliRunner();
    await runner.runOneShot('p');
    expect(oneShotMock.mock.calls[0][1]).toEqual(['--print', 'p']);
    await runner.runOneShot('p', { model: 'opus' });
    expect(oneShotMock.mock.calls[1][1]).toEqual(['--print', '--model', 'opus', 'p']);
  });

  it('runContextPass allows only read tools and sets cwd', async () => {
    oneShotMock.mockResolvedValue('brief');
    const runner = createCliRunner();
    await runner.runContextPass('p', '/proj');
    const [, args, opts] = oneShotMock.mock.calls[0];
    expect(args).toEqual(['--print', '--allowedTools=Read,Grep,Glob', 'p']);
    expect(opts.cwd).toBe('/proj');
  });

  it('abortActive kills children registered via onChild', async () => {
    const kill = vi.fn();
    streamingMock.mockImplementation((_b: string, _a: string[], opts: { onChild: (c: unknown) => void }) => {
      opts.onChild({ kill, once: vi.fn() });
      return new Promise(() => {}); // never resolves — simulates in-flight turn
    });
    const runner = createCliRunner();
    void runner.runTurn(claudeSeat, 'sys', 'prompt', () => {});
    runner.abortActive();
    expect(kill).toHaveBeenCalled();
  });

  it('abortActive skips children that already closed', async () => {
    const kill = vi.fn();
    let closeCb: (() => void) | undefined;
    streamingMock.mockImplementation((_b: string, _a: string[], opts: { onChild: (c: unknown) => void }) => {
      opts.onChild({
        kill,
        once: (event: string, cb: () => void) => { if (event === 'close') closeCb = cb; },
      });
      return new Promise(() => {});
    });
    const runner = createCliRunner();
    void runner.runTurn(claudeSeat, 'sys', 'prompt', () => {});
    closeCb!();            // simulate the child finishing naturally
    runner.abortActive();
    expect(kill).not.toHaveBeenCalled();
  });
});
