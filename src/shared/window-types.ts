export const PRIMARY_WINDOW_ID = 'primary';

/** HTML5 DataTransfer type for dragging a Nightyard tab between windows. */
export const TAB_DRAG_TYPE = 'application/x-nightyard-tab';

export interface TabDragPayload {
  sessionId: string;
  sourceWindowId: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SecondaryWindowRecord {
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
  bounds: WindowBounds;
}

/** Broadcast to renderers whenever window/session assignment changes. */
export interface WindowsSnapshot {
  hostWindows: SecondaryWindowRecord[];
}
