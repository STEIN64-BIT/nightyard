export const MAX_BUFFER_BYTES = 1024 * 1024;

interface Chunk { seq: number; data: string; bytes: number }

interface SessionBuffer { chunks: Chunk[]; totalBytes: number; nextSeq: number }

/**
 * Rolling per-session mirror of pty output so any window can replay a
 * terminal's recent content when it mounts (tab detach, re-attach, Cmd+R).
 * Seq numbers are monotonic per session and never reset, so a renderer can
 * dedupe live chunks that raced a snapshot fetch.
 */
export class PtyBufferStore {
  private buffers = new Map<string, SessionBuffer>();

  private bufferFor(sessionId: string): SessionBuffer {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], totalBytes: 0, nextSeq: 1 };
      this.buffers.set(sessionId, buf);
    }
    return buf;
  }

  append(sessionId: string, data: string): number {
    const buf = this.bufferFor(sessionId);
    const seq = buf.nextSeq++;
    const bytes = Buffer.byteLength(data);
    buf.chunks.push({ seq, data, bytes });
    buf.totalBytes += bytes;
    while (buf.totalBytes > MAX_BUFFER_BYTES && buf.chunks.length > 1) {
      const evicted = buf.chunks.shift()!;
      buf.totalBytes -= evicted.bytes;
    }
    return seq;
  }

  get(sessionId: string): { data: string; lastSeq: number } {
    const buf = this.buffers.get(sessionId);
    if (!buf) return { data: '', lastSeq: 0 };
    return {
      data: buf.chunks.map((c) => c.data).join(''),
      lastSeq: buf.nextSeq - 1,
    };
  }

  clear(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) return;
    buf.chunks = [];
    buf.totalBytes = 0;
  }

  clearAll(): void {
    this.buffers.clear();
  }
}

export const ptyBuffers = new PtyBufferStore();
