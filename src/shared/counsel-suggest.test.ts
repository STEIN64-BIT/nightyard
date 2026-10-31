import { describe, it, expect } from 'vitest';
import { suggestSeats } from './counsel-suggest';
import type { TeamMember } from './types';

const member = (id: string, name: string, role: string, description = ''): TeamMember => ({
  id, name, role, description, systemPrompt: 'x', source: 'custom', createdAt: 0, updatedAt: 0,
});

const roster = [
  member('1', 'Morgan Prime', 'Butler', 'dry, capable generalist'),
  member('2', 'Backend Architect', 'Engineer', 'api design database schema scaling'),
  member('3', 'CMO', 'Marketing', 'positioning ads campaigns growth'),
  member('4', 'Security Engineer', 'Engineer', 'threat modeling vulnerabilities auth'),
];

describe('suggestSeats', () => {
  it('scores keyword overlap with name+role+description', () => {
    const picks = suggestSeats('how should I design the database schema for scaling?', roster);
    expect(picks.map((m) => m.id)).toContain('2');
  });
  it('returns exactly three distinct members when possible', () => {
    const picks = suggestSeats('anything', roster);
    expect(picks).toHaveLength(3);
    expect(new Set(picks.map((m) => m.id)).size).toBe(3);
  });
  it('returns all members when fewer than three exist', () => {
    expect(suggestSeats('q', roster.slice(0, 2))).toHaveLength(2);
    expect(suggestSeats('q', [])).toHaveLength(0);
  });
  it('short words (< 3 chars) do not score', () => {
    const a = suggestSeats('is it ok to go?', roster).map((m) => m.id);
    const b = suggestSeats('?', roster).map((m) => m.id);
    expect(a).toEqual(b);
  });
});
