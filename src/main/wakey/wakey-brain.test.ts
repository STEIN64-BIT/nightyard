import { describe, it, expect, vi } from 'vitest';
import { createWakeyBrain, BRAIN_TURN_TIMEOUT_MS } from './wakey-brain';

// Fake SDK: reads user messages from the prompt iterable, emits one assistant
// text + one result per user message, echoing an incrementing turn number.
function fakeQuery(behavior: 'echo' | 'silent' = 'echo') {
  return (({ prompt }: { prompt: AsyncIterable<any> }) => {
    let n = 0;
    return (async function* () {
      for await (const _msg of prompt) {
        n += 1;
        if (behavior === 'silent') continue; // never emits → steer() must time out
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `steer ${n}` }] } };
        yield { type: 'result', subtype: 'success' };
      }
    })();
  }) as any;
}

const deps = (q: any) => ({ queryFn: q, model: 'sonnet', systemPrompt: 'sys', log: vi.fn() });

describe('wakey-brain', () => {
  it('runs the user\'s claude binary when one is given, and the SDK default otherwise', () => {
    const calls: any[] = [];
    const q = ((args: any) => { calls.push(args); return (async function* () {})(); }) as any;
    createWakeyBrain({ ...deps(q), claudePath: '/opt/bin/claude' }).dispose();
    createWakeyBrain(deps(q)).dispose();
    expect(calls[0].options.pathToClaudeCodeExecutable).toBe('/opt/bin/claude');
    expect(calls[1].options).not.toHaveProperty('pathToClaudeCodeExecutable');
    expect(calls[0].options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('answers sequential steers from one session and counts turns', async () => {
    const brain = createWakeyBrain(deps(fakeQuery()));
    expect(await brain.steer('ctx one')).toBe('steer 1');
    expect(await brain.steer('ctx two')).toBe('steer 2');
    expect(brain.turns()).toBe(2);
    await brain.dispose();
  });

  it('rejects a steer that gets no result within the timeout', async () => {
    vi.useFakeTimers();
    const brain = createWakeyBrain(deps(fakeQuery('silent')));
    const p = brain.steer('ctx').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(BRAIN_TURN_TIMEOUT_MS + 1000);
    expect(await p).toMatch(/timed out/);
    vi.useRealTimers();
    await brain.dispose();
  });

  it('rejects steers after dispose', async () => {
    const brain = createWakeyBrain(deps(fakeQuery()));
    await brain.dispose();
    await expect(brain.steer('ctx')).rejects.toThrow(/disposed/);
  });

  it('a steer timeout is fatal to the session: a later steer never resolves with the stale turn\'s answer', async () => {
    vi.useFakeTimers();
    let calls = 0;
    // Turn A (the first push) never responds, so steer('A') times out. If a
    // second push ever reached this fake (i.e. steer('B') were allowed to go
    // through), it would answer with A's stale text — reproducing the old
    // bug where a late assistant/result for a timed-out turn gets attributed
    // to the next steer. The fix must make that second push unreachable.
    const q = (({ prompt }: { prompt: AsyncIterable<any> }) => {
      return (async function* () {
        for await (const _msg of prompt) {
          calls += 1;
          if (calls === 1) continue;
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'stale A answer' }] } };
          yield { type: 'result', subtype: 'success' };
        }
      })();
    }) as any;
    const brain = createWakeyBrain(deps(q));
    const pA = brain.steer('A').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(BRAIN_TURN_TIMEOUT_MS + 1000);
    expect(await pA).toMatch(/timed out/);
    await expect(brain.steer('B')).rejects.toThrow(/disposed/);
    expect(calls).toBe(1); // steer('B') must never have reached the SDK session
    vi.useRealTimers();
    await brain.dispose();
  });

  it('rejects a steer when the result subtype signals an error, instead of resolving empty', async () => {
    const q = (({ prompt }: { prompt: AsyncIterable<any> }) => {
      return (async function* () {
        for await (const _msg of prompt) {
          yield { type: 'result', subtype: 'error_max_turns' };
        }
      })();
    }) as any;
    const brain = createWakeyBrain(deps(q));
    await expect(brain.steer('ctx')).rejects.toThrow(/error_max_turns/);
    await brain.dispose();
  });
});
