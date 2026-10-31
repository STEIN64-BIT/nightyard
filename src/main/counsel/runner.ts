import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { CounselSeatConfig } from '../../shared/types';
import { resolveBinary } from '../providers/resolve-binary';
import { getFullPath } from '../pty-manager';
import { spawnOneShot } from '../providers-oneshot/one-shot';
import { spawnStreaming, parseClaudeStreamLine, parseCodexStreamLine } from '../providers-oneshot/streaming-spawn';

export interface CounselRunner {
  runTurn(seat: CounselSeatConfig, systemPrompt: string, turnPrompt: string, onChunk: (t: string) => void): Promise<string>;
  runOneShot(prompt: string, opts?: { model?: string }): Promise<string>;
  runContextPass(prompt: string, projectPath: string): Promise<string>;
  abortActive(): void;
}

export function buildClaudeTurnArgs(systemPrompt: string, turnPrompt: string, model?: string): string[] {
  return [
    '--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ...(model ? ['--model', model] : []),
    '--append-system-prompt', systemPrompt, turnPrompt,
  ];
}

/** --allowedTools is variadic: the '=' form binds exactly one value so the
 *  positional prompt can never be swallowed as a tool name (which made every
 *  context pass fail with "Input must be provided" and a silent null brief). */
export function buildContextPassArgs(prompt: string): string[] {
  return ['--print', '--allowedTools=Read,Grep,Glob', prompt];
}

export function buildCodexTurnArgs(systemPrompt: string, turnPrompt: string, lastMessagePath: string, model?: string): string[] {
  return [
    'exec', '--json', '--output-last-message', lastMessagePath,
    ...(model ? ['--model', model] : []),
    '-c', `developer_instructions=${systemPrompt}`, turnPrompt,
  ];
}

const claudeCache = { path: null as string | null };
const codexCache = { path: null as string | null };

export function createCliRunner(opts?: { turnTimeoutMs?: number; oneShotTimeoutMs?: number }): CounselRunner {
  const turnTimeoutMs = opts?.turnTimeoutMs ?? 300_000;
  const oneShotTimeoutMs = opts?.oneShotTimeoutMs ?? 120_000;
  const active = new Set<ChildProcess>();
  // The app inherits launchd's bare PATH; codex resolves to an nvm
  // '#!/usr/bin/env node' script, so without a login-shell PATH the child
  // dies with exit 127 ("env: node: No such file or directory") and the
  // whole debate stops after seat A's first turn.
  const spawnEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: getFullPath() });
  const track = (child: ChildProcess) => {
    active.add(child);
    child.once('close', () => active.delete(child));
  };

  return {
    runTurn(seat, systemPrompt, turnPrompt, onChunk) {
      if (seat.providerId === 'codex') {
        const lastMessagePath = path.join(os.tmpdir(), `counsel-codex-${randomUUID()}.txt`);
        return spawnStreaming(resolveBinary('codex', codexCache), buildCodexTurnArgs(systemPrompt, turnPrompt, lastMessagePath, seat.model), {
          onChunk,
          parseLine: parseCodexStreamLine,
          timeoutMs: turnTimeoutMs,
          env: spawnEnv(),
          onChild: track,
          finalText: () => {
            try {
              const text = fs.readFileSync(lastMessagePath, 'utf-8').trim();
              fs.rmSync(lastMessagePath, { force: true });
              return text || null;
            } catch {
              return null;
            }
          },
        });
      }
      return spawnStreaming(resolveBinary('claude', claudeCache), buildClaudeTurnArgs(systemPrompt, turnPrompt, seat.model), {
        onChunk,
        parseLine: parseClaudeStreamLine,
        timeoutMs: turnTimeoutMs,
        env: spawnEnv(),
        onChild: track,
      });
    },

    runOneShot(prompt, o) {
      const args = ['--print', ...(o?.model ? ['--model', o.model] : []), prompt];
      return spawnOneShot(resolveBinary('claude', claudeCache), args, { timeoutMs: oneShotTimeoutMs, env: spawnEnv(), onChild: track });
    },

    runContextPass(prompt, projectPath) {
      return spawnOneShot(
        resolveBinary('claude', claudeCache),
        buildContextPassArgs(prompt),
        { timeoutMs: oneShotTimeoutMs, cwd: projectPath, env: spawnEnv(), onChild: track },
      );
    },

    abortActive() {
      for (const child of active) child.kill();
      active.clear();
    },
  };
}
