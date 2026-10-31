import { spawn } from 'node:child_process';

export interface PublishResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;

// The publish command is the user's own shell line. Sleepy hands it the
// report path and project name, waits at most a minute, and never lets a
// failure escape: the report exists on disk regardless of what happens here.
export function runPublishCommand(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<PublishResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: opts.cwd, shell: true, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8').slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + err.message, timedOut, exitCode: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, output, timedOut, exitCode: code });
    });
  });
}
