import { spawn, type ChildProcess } from 'child_process';

export interface OneShotOpts {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onChild?: (child: ChildProcess) => void;
}

/** Run a CLI once, buffered. Resolves trimmed stdout on exit 0. */
export function spawnOneShot(binary: string, args: string[], opts: OneShotOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, env: opts.env });
    opts.onChild?.(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

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

    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${binary} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}
