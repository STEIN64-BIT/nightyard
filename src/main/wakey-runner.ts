import { spawn } from 'node:child_process';
import { getFullPath } from './pty-manager';
import { resolveBinary } from './providers/resolve-binary';

export interface SuperviseOptions {
  cwd: string;
  sessionId: string;
  systemPrompt: string;
  userPrompt: string;
  provider?: 'opus' | 'codex';
  signal?: AbortSignal;
}

/**
 * Pure function that assembles the user-side prompt sent to the Wakey supervisor.
 * Keeps all context sections in one place so callers and tests can rely on a
 * single, predictable format.
 */
export function buildUserPrompt(opts: {
  transcript: string;
  direction?: string;
  recentPrompts?: string[];
  boardContext?: string;
  cwd?: string;
}): string {
  const parts: string[] = [];
  if (opts.cwd) parts.push(`Decide what the user should type next in this Claude Code session at ${opts.cwd}.`);
  if (opts.direction) {
    parts.push(
      `USER DIRECTION (highest priority): ${opts.direction}\n` +
      `Bias every next action toward this direction. Verify the requested outcome, then STOP when it is complete. Do not invent unrelated work to keep the session busy.`,
    );
  }
  if (opts.boardContext) parts.push(`KANBAN BOARD (project priorities):\n${opts.boardContext}`);
  if (opts.recentPrompts?.length) {
    parts.push(
      `YOUR RECENT STEERS (newest first) — do NOT repeat these or trivially rephrase them; pick a genuinely different next action if the transcript shows they didn't move things forward:\n` +
      opts.recentPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n'),
    );
  }
  parts.push(`RECENT TRANSCRIPT:\n${opts.transcript}`);
  parts.push(
    `Output JUST the literal text the user should type. DO NOT output bare "continue" — propose a SPECIFIC next action grounded in the transcript above. Reply with STOP only if the goal is genuinely complete or you see a destructive loop.`,
  );
  return parts.join('\n\n');
}

export const DEFAULT_WAKEY_SYSTEM_PROMPT =
  `You are Wakey, an autonomous supervisor for a Claude Code session running in another window.
The user has toggled you ON to keep the session productive without their input. Default to KEEP GOING.

You receive a recent transcript. Produce ONE short, SUBSTANTIVE next-turn message.

CRITICAL RULES:
1. NEVER output bare "continue", "ok", "go ahead", "next", or other empty filler. The worker loses direction when those are sent — it has explicitly asked you to be specific.
2. Always propose a CONCRETE action: a file to inspect, a test to run, a feature to build, a bug to investigate, a question to answer.
3. Prefer actions grounded in the transcript: pick up the next item from a plan the assistant outlined; verify a recently-committed change; investigate a flaky test; expand on a partial result.
4. If the assistant proposed multiple options, pick one and tell it to do that one — name the option.
5. If the assistant asked yes/no and proceeding is reasonable, answer "y" or "yes, do it" with a brief reason.
6. For routine permission prompts on Read/Edit/Bash, reply "y".
7. If the session is fresh with no prior turns, propose a meaningful first task — e.g. "read CLAUDE.md and recent commits, then pick the highest-impact open item and work on it".

STOP only when:
- The assistant explicitly stated the entire user-level goal is COMPLETE and nothing is left.
- You detect a destructive loop (same tool failing repeatedly with same error).
- The assistant has explicitly stopped and asked for direction you cannot reasonably provide from context.

When stopping, output the single literal word STOP. Otherwise output 1–3 sentences naming a specific action.

Output ONLY the literal text the user would type. No quotes, no commentary, no markdown, no preamble.`;

const SUPERVISE_TIMEOUT_MS = 90_000;
const activeSupervisors = new Map<string, () => void>();

export function cancelSupervision(sessionId: string): void {
  activeSupervisors.get(sessionId)?.();
}

export async function superviseOnce(opts: SuperviseOptions): Promise<string> {
  if (opts.signal?.aborted) throw new Error('Wakey: supervision cancelled');
  cancelSupervision(opts.sessionId);
  const provider = opts.provider === 'codex' ? 'codex' : 'claude';
  const binary = resolveBinary(provider, { path: null });
  if (!binary) {
    throw new Error(`Wakey: ${provider} binary not found`);
  }
  // Subscription-only, exactly like the persistent brain: an ambient API key in
  // the environment would silently put every fallback turn of an unattended
  // auto-resuming loop on metered API billing.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: getFullPath() };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise<string>((resolve, reject) => {
    // This process only decides the next instruction; the existing worker
    // owns execution. Avoid loading a second set of project tools and MCPs.
    const args = provider === 'codex'
      ? ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'features.apps=false',
        '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
        '-c', 'mcp_servers={}', '--color', 'never', '-']
      : ['-p', '--append-system-prompt', opts.systemPrompt, '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(opts.provider === 'opus' ? ['--model', 'opus'] : [])];
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeSupervisors.delete(opts.sessionId);
      opts.signal?.removeEventListener('abort', cancel);
      child.kill('SIGKILL');
      reject(new Error('Wakey: supervision cancelled'));
    };
    activeSupervisors.set(opts.sessionId, cancel);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeSupervisors.delete(opts.sessionId);
      opts.signal?.removeEventListener('abort', cancel);
      child.kill('SIGKILL');
      reject(new Error('Wakey: supervisor timed out'));
    }, SUPERVISE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf-8')).slice(-32_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf-8')).slice(-4000); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      activeSupervisors.delete(opts.sessionId);
      opts.signal?.removeEventListener('abort', cancel);
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Wakey supervisor exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      activeSupervisors.delete(opts.sessionId);
      opts.signal?.removeEventListener('abort', cancel);
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.on('error', () => {}); // spawn/close report a failed process
    opts.signal?.addEventListener('abort', cancel, { once: true });
    if (opts.signal?.aborted) { cancel(); return; }
    child.stdin.write(provider === 'codex' ? `${opts.systemPrompt}\n\nINPUT EVIDENCE:\n${opts.userPrompt}` : opts.userPrompt);
    child.stdin.end();
  });
}
