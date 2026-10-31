/**
 * Coalesces rapid-fire text chunks (e.g. CLI stdout deltas) into at most one
 * `apply` call per animation frame, so a bursty stream of small deltas
 * doesn't force a DOM write (and layout) per chunk. Falls back to applying
 * immediately when `requestAnimationFrame` isn't available (Node test
 * environment) — there's no frame to batch against, so every push is its
 * own "frame".
 */
export function createDeltaCoalescer(apply: (text: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = '';
  let scheduled = false;

  function run(): void {
    scheduled = false;
    if (!buffer) return;
    const text = buffer;
    buffer = '';
    apply(text);
  }

  function push(chunk: string): void {
    buffer += chunk;
    if (typeof requestAnimationFrame === 'undefined') {
      run();
      return;
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
  }

  function flush(): void {
    run();
  }

  return { push, flush };
}

/**
 * True when a scrollable element's viewport is within `thresholdPx` of its
 * bottom edge. Used to decide whether appending new content should also
 * auto-scroll — never yank the view down if the user has scrolled up to
 * read earlier turns.
 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx = 80,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}
