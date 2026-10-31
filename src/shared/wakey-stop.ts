/**
 * Single source-of-truth for the Wakey STOP-response predicate.
 * Used by the main-process core (src/main/wakey/wakey-core.ts), which owns
 * the supervision loop. The renderer is a thin IPC mirror and no longer
 * evaluates supervisor responses itself.
 *
 * Returns true when the supervisor response signals that the session should
 * stop: empty string, or the literal words STOP / ABORT / DONE (standalone
 * or at the start of the response).
 */
export function isStopResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const upper = trimmed.toUpperCase();
  return upper === 'STOP' || upper === 'ABORT' || upper === 'DONE'
    || /^(STOP|ABORT|DONE)\b/.test(upper);
}
