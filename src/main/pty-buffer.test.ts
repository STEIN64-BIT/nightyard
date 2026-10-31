import { describe, it, expect } from 'vitest';
import { PtyBufferStore, MAX_BUFFER_BYTES } from './pty-buffer';

describe('PtyBufferStore', () => {
  it('appends and returns monotonically increasing seqs per session', () => {
    const store = new PtyBufferStore();
    expect(store.append('a', 'x')).toBe(1);
    expect(store.append('a', 'y')).toBe(2);
    expect(store.append('b', 'z')).toBe(1);
  });

  it('snapshot concatenates chunks and reports lastSeq', () => {
    const store = new PtyBufferStore();
    store.append('a', 'hel');
    store.append('a', 'lo');
    expect(store.get('a')).toEqual({ data: 'hello', lastSeq: 2 });
  });

  it('returns empty snapshot for unknown session', () => {
    const store = new PtyBufferStore();
    expect(store.get('nope')).toEqual({ data: '', lastSeq: 0 });
  });

  it('evicts whole chunks from the head to stay under the byte cap', () => {
    const store = new PtyBufferStore();
    const chunk = 'x'.repeat(100_000);
    for (let i = 0; i < 12; i++) store.append('a', chunk); // 1.2 MB
    const snap = store.get('a');
    expect(Buffer.byteLength(snap.data)).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    expect(snap.lastSeq).toBe(12); // seqs unaffected by eviction
  });

  it('clear empties data but does not reset seq numbering', () => {
    const store = new PtyBufferStore();
    store.append('a', 'one');
    store.clear('a');
    expect(store.get('a')).toEqual({ data: '', lastSeq: 1 });
    expect(store.append('a', 'two')).toBe(2);
    expect(store.get('a')).toEqual({ data: 'two', lastSeq: 2 });
  });
});
