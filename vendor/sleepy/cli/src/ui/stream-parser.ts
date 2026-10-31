import { cyan, magenta, gray, dim, yellow } from './colors.js';

/**
 * Parse and render Claude Code `--output-format stream-json --verbose`
 * events into human-readable colored lines for the terminal.
 *
 * Each line of stream-json output is a JSON object with a `type` field.
 * We care about:
 *   - system.init         → session started
 *   - assistant.message   → contains content blocks (text, tool_use, thinking)
 *   - user.message        → tool results (summarize briefly)
 *   - result              → session done
 */

export interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: {
    content?: Array<ContentBlock>;
    role?: string;
  };
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

function shortPath(p: string): string {
  if (p.length < 55) return p;
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-3).join('/');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  if (name === 'Read' && typeof o['file_path'] === 'string') {
    return shortPath(o['file_path']);
  }
  if (name === 'Write' && typeof o['file_path'] === 'string') {
    return shortPath(o['file_path']);
  }
  if (name === 'Edit' && typeof o['file_path'] === 'string') {
    return shortPath(o['file_path']);
  }
  if (name === 'Bash' && typeof o['command'] === 'string') {
    return truncate(o['command'], 70);
  }
  if (name === 'Glob' && typeof o['pattern'] === 'string') {
    return o['pattern'];
  }
  if (name === 'Grep' && typeof o['pattern'] === 'string') {
    return o['pattern'];
  }
  if (name === 'TodoWrite') {
    return '(todo list)';
  }
  if (name === 'Task' && typeof o['description'] === 'string') {
    return truncate(o['description'], 60);
  }
  return '';
}

/**
 * Convert a single parsed stream event into zero or more display lines.
 * Each returned string is a single already-prefixed-and-colored line
 * (no trailing newline).
 */
export function renderStreamEvent(
  ev: StreamEvent,
  prefix: string,
): string[] {
  // system.init — session started
  if (ev.type === 'system' && ev.subtype === 'init') {
    return [prefix + dim('session started')];
  }

  // result — session done
  if (ev.type === 'result') {
    return [prefix + dim('session done')];
  }

  // assistant — the meat. Iterate content blocks.
  if (ev.type === 'assistant' && ev.message?.content) {
    const out: string[] = [];
    for (const block of ev.message.content) {
      if (!block) continue;

      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (!text) continue;
        // Split multi-line text into separate prefixed lines
        for (const line of text.split('\n')) {
          out.push(prefix + line);
        }
        continue;
      }

      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const summary = summarizeToolInput(block.name, block.input);
        const display = summary
          ? `${yellow('→')} ${cyan(block.name)}${gray('(')}${summary}${gray(')')}`
          : `${yellow('→')} ${cyan(block.name)}`;
        out.push(prefix + display);
        continue;
      }

      if (block.type === 'thinking') {
        out.push(prefix + dim('(thinking…)'));
        continue;
      }
    }
    return out;
  }

  // user — typically a tool result. Summarize briefly.
  if (ev.type === 'user' && ev.message?.content) {
    const out: string[] = [];
    for (const block of ev.message.content) {
      if (!block) continue;
      // Tool results come back as content blocks with type 'tool_result'
      if (block.type === 'tool_result') {
        out.push(prefix + gray('  ↳ done'));
      }
    }
    return out;
  }

  return [];
}

/**
 * Stateful line-buffered renderer. Feed it raw stdout chunks; it accumulates
 * until it has complete JSON lines, parses each, renders, and writes the
 * result to the given output stream.
 */
export class StreamRenderer {
  private buffer = '';

  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly prefix: string,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const ev = parseStreamLine(line);
      if (!ev) continue;
      const displayLines = renderStreamEvent(ev, this.prefix);
      for (const d of displayLines) {
        this.out.write(d + '\n');
      }
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      const ev = parseStreamLine(this.buffer);
      if (ev) {
        for (const d of renderStreamEvent(ev, this.prefix)) {
          this.out.write(d + '\n');
        }
      }
      this.buffer = '';
    }
  }
}

// Cyan/magenta colors used elsewhere — re-exported so consumers have a
// single import point for stream UI utilities.
export { cyan, magenta } from './colors.js';
