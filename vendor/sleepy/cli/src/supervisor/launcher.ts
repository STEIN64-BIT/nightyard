import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ClaudeLaunchOptions {
  prompt: string;
  cwd: string;
}

export interface ClaudeLaunchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionFile: string | null;
  durationMs: number;
}

export interface ClaudeLauncher {
  run(opts: ClaudeLaunchOptions): Promise<ClaudeLaunchResult>;
}

export interface FakeClaudeLauncherInput {
  result: ClaudeLaunchResult;
  sessionFileContent: string;
}

export class FakeClaudeLauncher implements ClaudeLauncher {
  readonly calls: ClaudeLaunchOptions[] = [];

  constructor(private readonly input: FakeClaudeLauncherInput) {}

  async run(opts: ClaudeLaunchOptions): Promise<ClaudeLaunchResult> {
    this.calls.push(opts);
    if (this.input.result.sessionFile) {
      await mkdir(path.dirname(this.input.result.sessionFile), { recursive: true });
      await writeFile(
        this.input.result.sessionFile,
        this.input.sessionFileContent,
        'utf8',
      );
    }
    return this.input.result;
  }
}
