import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { spawnStreaming, parseClaudeStreamLine, parseCodexStreamLine } from './streaming-spawn';

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const claudeDelta = (text: string) =>
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

describe('parseClaudeStreamLine', () => {
  it('extracts text deltas', () => {
    expect(parseClaudeStreamLine(claudeDelta('hi'))).toBe('hi');
  });
  it('ignores other event types', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system' }))).toBeNull();
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull();
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_delta' } }))).toBeNull();
  });
  it('returns null on garbage without throwing', () => {
    expect(parseClaudeStreamLine('not json')).toBeNull();
  });
});

describe('spawnStreaming', () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.useRealTimers());

  function run(opts: Partial<Parameters<typeof spawnStreaming>[2]> = {}) {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const chunks: string[] = [];
    const promise = spawnStreaming('claude', [], {
      onChunk: (t) => chunks.push(t),
      parseLine: parseClaudeStreamLine,
      timeoutMs: 1000,
      ...opts,
    });
    return { child, chunks, promise };
  }

  it('emits chunks and resolves the concatenated text', async () => {
    const { child, chunks, promise } = run();
    child.stdout.emit('data', Buffer.from(claudeDelta('a') + '\n' + claudeDelta('b') + '\n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('ab');
    expect(chunks).toEqual(['a', 'b']);
  });

  it('handles one JSON line split across two data events', async () => {
    const { child, chunks, promise } = run();
    const line = claudeDelta('split') + '\n';
    child.stdout.emit('data', Buffer.from(line.slice(0, 10)));
    child.stdout.emit('data', Buffer.from(line.slice(10)));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('split');
    expect(chunks).toEqual(['split']);
  });

  it('strips \\r and survives garbage lines between good ones', async () => {
    const { child, promise } = run();
    child.stdout.emit('data', Buffer.from(claudeDelta('a') + '\r\n???garbage???\n' + claudeDelta('b') + '\n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('ab');
  });

  it('flushes a trailing partial line on close', async () => {
    const { child, promise } = run();
    child.stdout.emit('data', Buffer.from(claudeDelta('tail'))); // no trailing newline
    child.emit('close', 0);
    await expect(promise).resolves.toBe('tail');
  });

  it('a throwing onChunk never kills the stream', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const promise = spawnStreaming('claude', [], {
      onChunk: () => { throw new Error('ui exploded'); },
      parseLine: parseClaudeStreamLine,
      timeoutMs: 1000,
    });
    child.stdout.emit('data', Buffer.from(claudeDelta('ok') + '\n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('ok');
  });

  it('prefers finalText content even on non-zero exit', async () => {
    const { child, promise } = run({ finalText: () => 'canonical answer' });
    child.stderr.emit('data', Buffer.from('deprecation warning'));
    child.emit('close', 1);
    await expect(promise).resolves.toBe('canonical answer');
  });

  it('rejects on non-zero exit without finalText content', async () => {
    const { child, promise } = run({ finalText: () => null });
    child.stderr.emit('data', Buffer.from('real failure'));
    child.emit('close', 2);
    await expect(promise).rejects.toThrow(/real failure/);
  });

  it('rejects and kills on timeout', async () => {
    vi.useFakeTimers();
    const { child, promise } = run({ timeoutMs: 50 });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(51);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reassembles multi-byte utf-8 characters split across data events', async () => {
    const { child, promise } = run();
    const buf = Buffer.from(claudeDelta('😀') + '\n');
    const splitAt = buf.indexOf(Buffer.from('😀')) + 2; // inside the 4-byte emoji
    child.stdout.emit('data', buf.subarray(0, splitAt));
    child.stdout.emit('data', buf.subarray(splitAt));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('😀');
  });

  it('detaches stdout after timeout so late chunks never reach onChunk', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const chunks: string[] = [];
    const promise = spawnStreaming('claude', [], { onChunk: (t) => chunks.push(t), parseLine: parseClaudeStreamLine, timeoutMs: 50 });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(51);
    await assertion;
    child.stdout.emit('data', Buffer.from(claudeDelta('late') + '\n'));
    expect(chunks).toEqual([]);
    vi.useRealTimers();
  });

  it('escalates to SIGKILL when the child survives SIGTERM', async () => {
    vi.useFakeTimers();
    const { child, promise } = run({ timeoutMs: 50 });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(51);
    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});

describe('parseCodexStreamLine', () => {
  it('extracts the agent message on item.completed', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'full turn' } });
    expect(parseCodexStreamLine(line)).toBe('full turn');
  });
  it('ignores other items and event types', () => {
    expect(parseCodexStreamLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'x' } }))).toBeNull();
    expect(parseCodexStreamLine(JSON.stringify({ type: 'turn.started' }))).toBeNull();
  });
  it('returns null on garbage', () => {
    expect(parseCodexStreamLine('###')).toBeNull();
  });
});
