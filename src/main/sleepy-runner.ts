import { spawn, type ChildProcess } from 'node:child_process';
import { getFullPath } from './pty-manager';

export interface SleepyHandle {
  child: ChildProcess;
  pid: number;
}

export const sleepyHandles = new Map<string, SleepyHandle>();

export interface SpawnOptions {
  sleepyBin: string;
  args: string[];
  cwd: string;
  onData: (chunk: string, stream: 'stdout' | 'stderr') => void;
  onExit: (code: number | null) => void;
  /** How to run Node: Nightyard passes its own Electron-as-Node; defaults to `node` on PATH. */
  node?: { command: string; env: Record<string, string> };
}

export function spawnSleepy(opts: SpawnOptions): SleepyHandle {
  // Use Nightyard's PATH-augmenting helper so we pick up nvm/homebrew node, not just GUI-launched PATH.
  const node = opts.node ?? { command: 'node', env: {} };
  const child = spawn(node.command, [opts.sleepyBin, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, PATH: getFullPath(), ...node.env },
  });
  child.stdout.on('data', (chunk) => opts.onData(chunk.toString('utf-8'), 'stdout'));
  child.stderr.on('data', (chunk) => opts.onData(chunk.toString('utf-8'), 'stderr'));
  let finished = false;
  const finish = (code: number | null) => { if (!finished) { finished = true; opts.onExit(code); } };
  child.on('error', (err) => { opts.onData(`Sleepy could not start: ${err.message}\n`, 'stderr'); finish(1); });
  child.on('exit', finish);
  return { child, pid: child.pid ?? 0 };
}

const SIGKILL_FALLBACK_MS = 5_000;

export function killSleepy(handle: SleepyHandle): void {
  handle.child.kill('SIGTERM');
  const timer = setTimeout(() => {
    // Child is still running after SIGTERM grace period — escalate to SIGKILL.
    handle.child.kill('SIGKILL');
  }, SIGKILL_FALLBACK_MS);
  // Once the child exits (for any reason) clear the pending SIGKILL.
  handle.child.once('exit', () => clearTimeout(timer));
}
