import { TAB_DRAG_TYPE, type TabDragPayload } from '../../shared/window-types.js';
import type { SessionRecord } from '../../shared/types.js';

export { TAB_DRAG_TYPE };

/** remote/sleepy panes hold live per-window connections; sharing pins a session to its host. */
export function isDetachable(session: Pick<SessionRecord, 'type'>, sharing: boolean): boolean {
  if (sharing) return false;
  return session.type !== 'remote-terminal' && session.type !== 'sleepy';
}

export function writeTabDragPayload(dt: DataTransfer, payload: TabDragPayload): void {
  dt.setData(TAB_DRAG_TYPE, JSON.stringify(payload));
}

export function hasTabDragPayload(dt: DataTransfer): boolean {
  return dt.types.includes(TAB_DRAG_TYPE);
}

export function readTabDragPayload(dt: DataTransfer): TabDragPayload | null {
  const raw = dt.getData(TAB_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TabDragPayload;
    return parsed.sessionId && parsed.sourceWindowId ? parsed : null;
  } catch {
    return null;
  }
}

/** Index in the strip a drop at clientX maps to (left half = before, right half = after). */
export function computeDropIndex(tabRects: Array<{ left: number; width: number }>, clientX: number): number {
  for (let i = 0; i < tabRects.length; i++) {
    const mid = tabRects[i].left + tabRects[i].width / 2;
    if (clientX < mid) return i;
  }
  return tabRects.length;
}
