import { describe, it, expect } from 'vitest';
import type { ProjectRecord } from '../../shared/types.js';
import { sortProjectsForSidebar } from './project-sort.js';

function project(id: string, lastUsedAt?: number): ProjectRecord {
  return {
    id,
    name: id,
    path: `/${id}`,
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
    lastUsedAt,
  };
}

describe('sortProjectsForSidebar', () => {
  it('manual mode returns the array in its current order, unchanged', () => {
    const projects = [project('a', 100), project('b', 300), project('c', 200)];
    const result = sortProjectsForSidebar(projects, 'manual');
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('manual mode does not mutate or reorder even when timestamps disagree', () => {
    const projects = [project('a'), project('b', 5), project('c', 1)];
    const result = sortProjectsForSidebar(projects, 'manual');
    expect(result).toBe(projects); // same reference — no copy needed for manual
  });

  it('recent mode orders by lastUsedAt descending (most recent first)', () => {
    const projects = [project('a', 100), project('b', 300), project('c', 200)];
    const result = sortProjectsForSidebar(projects, 'recent');
    expect(result.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('recent mode sorts projects with no lastUsedAt last', () => {
    const projects = [project('never-used'), project('used-once', 50)];
    const result = sortProjectsForSidebar(projects, 'recent');
    expect(result.map((p) => p.id)).toEqual(['used-once', 'never-used']);
  });

  it('recent mode falls back to original array order for ties (all untouched)', () => {
    // Fresh app, nothing stamped yet — should render identically to the current/manual order.
    const projects = [project('a'), project('b'), project('c')];
    const result = sortProjectsForSidebar(projects, 'recent');
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('recent mode falls back to original array order for exact timestamp ties', () => {
    const projects = [project('a', 500), project('b', 500), project('c', 500)];
    const result = sortProjectsForSidebar(projects, 'recent');
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('recent mode does not mutate the input array', () => {
    const projects = [project('a', 1), project('b', 2)];
    const original = [...projects];
    sortProjectsForSidebar(projects, 'recent');
    expect(projects).toEqual(original);
  });
});
