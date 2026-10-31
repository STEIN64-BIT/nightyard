/** Which window this renderer is running in. Guarded for vitest (no `window`). */
export const windowId: string =
  typeof window !== 'undefined' && window.nightyard?.windows ? window.nightyard.windows.id : 'primary';

export function isPrimaryWindow(): boolean {
  return windowId === 'primary';
}
