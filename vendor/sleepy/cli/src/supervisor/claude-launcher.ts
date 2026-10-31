import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  type ClaudeLauncher,
  type ClaudeLaunchOptions,
  type ClaudeLaunchResult,
} from './launcher.js';
import { findNewestSessionFile, defaultProjectsRoot } from './session-finder.js';
import { StreamRenderer } from '../ui/stream-parser.js';

export interface RealClaudeLauncherOptions {
  claudeBin?: string;
  projectsRoot?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  /**
   * When true, Claude is launched with `--output-format stream-json --verbose`
   * and the supervisor parses the event stream and writes human-readable
   * colored lines to process.stdout as they arrive. Provides real live
   * visibility into what the orchestrator or worker is doing.
   */
  streamOutput?: boolean;
  /**
   * Prefix prepended to each rendered output line. Use a colored prefix
   * to distinguish orchestrator output from worker output.
   */
  streamPrefix?: string;
}

/**
 * Every currently-spawned Claude child process. Exposed so the CLI can
 * kill them in response to ESC / Ctrl-C.
 */
const activeChildren: Set<ChildProcess> = new Set();

export function trackActiveChild(child: ChildProcess): () => void {
  activeChildren.add(child);
  return () => { activeChildren.delete(child); };
}

export function killAllActiveChildren(
  signal: NodeJS.Signals = 'SIGTERM',
): number {
  let killed = 0;
  for (const child of activeChildren) {
    try {
      child.kill(signal);
      killed += 1;
    } catch {
      // best effort
    }
  }
  return killed;
}

export function activeChildCount(): number {
  return activeChildren.size;
}

export class RealClaudeLauncher implements ClaudeLauncher {
  constructor(private readonly opts: RealClaudeLauncherOptions = {}) {}

  async run(launchOpts: ClaudeLaunchOptions): Promise<ClaudeLaunchResult> {
    const bin = this.opts.claudeBin ?? process.env.SLEEPY_CLAUDE_BIN ?? 'claude';
    const stream = this.opts.streamOutput === true;
    const sessionId = randomUUID();
    const args = ['-p', launchOpts.prompt, '--session-id', sessionId];
    if (stream) {
      args.push('--output-format', 'stream-json', '--verbose');
    }
    if (this.opts.extraArgs) {
      args.push(...this.opts.extraArgs);
    }

    const startedAtMs = Date.now() - 1000;
    const start = Date.now();

    const child = spawn(bin, args, {
      cwd: launchOpts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timeout = this.opts.timeoutMs ? setTimeout(() => {
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, this.opts.timeoutMs) : undefined;

    const prefix = this.opts.streamPrefix ?? '';
    const renderer = stream ? new StreamRenderer(process.stdout, prefix) : null;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (renderer) {
        renderer.feed(s);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderr += s;
      // Stderr passes through as-is (with prefix if streaming)
      if (stream) {
        for (const line of s.split('\n')) {
          if (line) process.stderr.write(prefix + line + '\n');
        }
      }
    });

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
      });
    } finally {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(escalation);
    }

    if (renderer) renderer.flush();

    const durationMs = Date.now() - start;

    const sessionFile = await findNewestSessionFile({
      projectsRoot: this.opts.projectsRoot ?? defaultProjectsRoot(),
      cutoffMs: startedAtMs,
      sessionId,
    });

    return {
      exitCode,
      stdout,
      stderr,
      sessionFile,
      durationMs,
    };
  }
}
