import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { spawnOneShot } from './one-shot';

export function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('spawnOneShot', () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.useRealTimers());

  it('resolves trimmed stdout on exit 0', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = spawnOneShot('claude', ['--print', 'hi'], { timeoutMs: 1000 });
    child.stdout.emit('data', Buffer.from('  answer\n'));
    child.emit('close', 0);
    await expect(p).resolves.toBe('answer');
  });

  it('rejects with stderr excerpt on non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = spawnOneShot('claude', [], { timeoutMs: 1000 });
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/boom/);
  });

  it('rejects and kills on timeout', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = spawnOneShot('claude', [], { timeoutMs: 50 });
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(51);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('rejects on spawn error event', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = spawnOneShot('nope', [], { timeoutMs: 1000 });
    child.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it('passes cwd through and reports the child via onChild', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const seen: unknown[] = [];
    const p = spawnOneShot('claude', [], { timeoutMs: 1000, cwd: '/proj', onChild: (c) => seen.push(c) });
    child.stdout.emit('data', Buffer.from('x'));
    child.emit('close', 0);
    await p;
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: '/proj' });
    expect(seen).toHaveLength(1);
  });

  it('escalates to SIGKILL when the child survives SIGTERM', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = spawnOneShot('claude', [], { timeoutMs: 50 });
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(51);
    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('does not escalate when the child dies after SIGTERM', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = spawnOneShot('claude', [], { timeoutMs: 50 });
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(51);
    await assertion;
    child.emit('close', null);
    vi.advanceTimersByTime(5000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
