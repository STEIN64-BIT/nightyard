import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface StreamingOpts {
  onChunk: (text: string) => void;
  parseLine: (line: string) => string | null;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Canonical full-text source read on close; if non-empty it wins even on non-zero exit. */
  finalText?: () => string | null;
  onChild?: (child: ChildProcess) => void;
}

export function spawnStreaming(binary: string, args: string[], opts: StreamingOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, env: opts.env });
    opts.onChild?.(child);

    let pending = '';
    let collected = '';
    let stderr = '';
    let settled = false;
    const decoder = new StringDecoder('utf8');

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.kill();
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => clearTimeout(killTimer));
      reject(new Error(`${binary} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const handleLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line) return;
      let text: string | null = null;
      try {
        text = opts.parseLine(line);
      } catch {
        return; // one malformed line must never kill the stream
      }
      if (text === null) return;
      collected += text;
      try {
        opts.onChunk(text);
      } catch {
        // UI forwarding errors must never kill the stream
      }
    };

    child.stdout!.on('data', (d: Buffer) => {
      pending += decoder.write(d);
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        handleLine(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
      }
    });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending += decoder.end();
      if (pending) handleLine(pending); // flush trailing partial line

      let canonical: string | null = null;
      try {
        canonical = opts.finalText?.() ?? null;
      } catch {
        canonical = null;
      }
      if (canonical) return resolve(canonical);
      if (code === 0) return resolve(collected);
      reject(new Error(`${binary} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** Keep only Claude stream-json text deltas; everything else is null. */
export function parseClaudeStreamLine(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (
      obj?.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta' &&
      typeof obj.event.delta.text === 'string'
    ) {
      return obj.event.delta.text;
    }
  } catch {
    // fallthrough
  }
  return null;
}

/** Codex emits the whole turn once via item.completed/agent_message; no token deltas. */
export function parseCodexStreamLine(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (obj?.type === 'item.completed' && obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') {
      return obj.item.text;
    }
  } catch {
    // fallthrough
  }
  return null;
}
