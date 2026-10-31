import type { ProjectRecord } from '../../shared/types.js';

export type ProjectSortMode = 'recent' | 'manual';

/**
 * Order projects for the sidebar list.
 * - 'manual': the current/persisted array order, unchanged (house behavior before this feature).
 * - 'recent': most-recently-used first (ProjectRecord.lastUsedAt desc). Projects that have never
 *   been used (no lastUsedAt — e.g. freshly added, or state from before this feature) sort last.
 *   Ties (including "everything untouched") fall back to the current array order via Array.sort's
 *   guaranteed stability, so a fresh app renders identically to 'manual' until the user interacts.
 * Never mutates `projects`.
 */
export function sortProjectsForSidebar(projects: ProjectRecord[], mode: ProjectSortMode): ProjectRecord[] {
  if (mode === 'manual') return projects;
  return [...projects].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}
