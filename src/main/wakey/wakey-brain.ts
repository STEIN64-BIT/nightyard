import { query as sdkQuery, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue';
import { getFullPath } from '../pty-manager';

export const BRAIN_TURN_CAP = 40;
export const BRAIN_TURN_TIMEOUT_MS = 60_000;

export interface WakeyBrainDeps {
  queryFn: typeof sdkQuery; model: string; systemPrompt: string; log(line: string): void;
  /** The user's own `claude` binary (and therefore its login). Omitted → the
   *  SDK's bundled CLI. */
  claudePath?: string;
}
export interface WakeyBrain {
  /**
   * Runs one supervision turn on the persistent session and resolves with the
   * assistant's accumulated text. Rejects if the brain is disposed, if a
   * steer is already in flight, if the underlying session ends, if the SDK
   * emits an error `result` subtype, or if 60s elapse with no `result`.
   *
   * A steer timeout is FATAL to this brain instance: the session is disposed
   * as part of handling the timeout (to prevent a late `assistant`/`result`
   * from a timed-out turn being misattributed to a later steer). The caller
   * must treat a timeout rejection as the end of this brain and construct a
   * new one — the wakey core's existing recycle-brain-on-steer-error path is
   * the designed recovery, not an incidental side effect.
   */
  steer(context: string): Promise<string>;
  turns(): number;
  dispose(): Promise<void>;
}

type PendingTurn = { resolve(text: string): void; reject(err: Error): void; buffer: string; timer: ReturnType<typeof setTimeout> };

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage;
}

export function createWakeyBrain(deps: WakeyBrainDeps): WakeyBrain {
  const input = new AsyncQueue<SDKUserMessage>();
  let disposed = false;
  let turnCount = 0;
  // The `as PendingTurn | null` on the initializer is load-bearing, not
  // decorative: TypeScript types a captured `let` inside a closure using its
  // narrowed type *at the closure's definition site*, not its declared type.
  // With a bare `= null` initializer, that narrowed type is the literal
  // `null` (correct at that exact line) — so every read of `pending` inside
  // the consumer closure below would see `null` only, and `if (pending)`
  // narrows straight to `never`. The cast widens the definition-site type
  // back to the full union so the closure sees the real declared type.
  let pending: PendingTurn | null = null as PendingTurn | null;

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: getFullPath() };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const stream = deps.queryFn({
    prompt: input,
    options: {
      model: deps.model, systemPrompt: deps.systemPrompt,
      tools: [], settingSources: [], strictMcpConfig: true,
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, env,
      ...(deps.claudePath ? { pathToClaudeCodeExecutable: deps.claudePath } : {}),
    },
  });

  const consumer = (async () => {
    try {
      for await (const msg of stream as AsyncIterable<any>) {
        if (!pending) continue;
        if (msg.type === 'assistant') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : [];
          pending.buffer += parts.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        } else if (msg.type === 'result') {
          clearTimeout(pending.timer);
          if (typeof msg.subtype === 'string' && msg.subtype.startsWith('error')) {
            pending.reject(new Error(`wakey brain result error: ${msg.subtype}`));
          } else {
            pending.resolve(pending.buffer.trim());
          }
          pending = null;
        }
      }
    } catch (err: any) {
      deps.log(`[wakey-brain] stream error: ${err?.message}`);
    } finally {
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('wakey brain session ended')); pending = null; }
      disposed = true;
    }
  })();

  return {
    steer(context: string): Promise<string> {
      if (disposed) return Promise.reject(new Error('wakey brain disposed'));
      if (pending) return Promise.reject(new Error('wakey brain busy'));
      turnCount += 1;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending) {
            // A timeout is fatal to this session: the SDK's late assistant
            // text / result for this turn can still arrive after we give up
            // on it. If we left the session live, that late traffic would
            // land in whatever steer() is pending *next* and silently
            // resolve it with this turn's stale answer. Killing the session
            // here guarantees no future steer can be corrupted by it — the
            // caller must dispose+recreate (the wakey core already recycles
            // brains on steer errors, so this is the designed recovery path).
            disposed = true;
            input.end();
            pending = null;
            reject(new Error('wakey brain steer timed out'));
          }
        }, BRAIN_TURN_TIMEOUT_MS);
        pending = { resolve, reject, buffer: '', timer };
        input.push(userMessage(context));
      });
    },
    turns: () => turnCount,
    async dispose(): Promise<void> {
      disposed = true;
      input.end();
      await Promise.race([consumer, new Promise((r) => setTimeout(r, 2000))]);
    },
  };
}
