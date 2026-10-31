import { describe, it, expect, vi, beforeEach } from 'vitest';

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

import { buildCliSession, buildCounselSession, buildNoteSession } from './session-factory';

describe('buildCounselSession', () => {
  beforeEach(() => {
    uuidCounter = 0;
  });

  it('creates a counsel tab session', () => {
    const s = buildCounselSession({ projectName: 'proj' });
    expect(s.type).toBe('counsel');
    expect(s.name).toBe('Counsel');
    expect(s.cliSessionId).toBeNull();
  });
});

describe('buildNoteSession', () => {
  beforeEach(() => {
    uuidCounter = 0;
  });

  it('creates a CLI session carrying note context as pendingInitialPrompt', () => {
    const s = buildNoteSession({
      noteId: 'Notes/Roadmap.md', noteTitle: 'Roadmap',
      noteContent: '# Roadmap\nship the beta in Q3', providerId: 'claude',
    });
    expect(s.providerId).toBe('claude');
    expect(s.sourceNoteId).toBe('Notes/Roadmap.md');
    expect(s.name).toBe('📝 Roadmap');
    expect(s.pendingInitialPrompt).toContain('ship the beta in Q3');
    expect(s.pendingInitialPrompt).toContain('Notes/Roadmap.md');
  });

  it('truncates noteContent at 8000 chars and appends [note truncated]', () => {
    // Build content that is 8001 chars: 8000 'A's + 1 'B' at position 8000.
    const boundary = 'A'.repeat(8000) + 'TAIL';
    const s = buildNoteSession({
      noteId: 'Notes/Long.md',
      noteTitle: 'Long',
      noteContent: boundary,
      providerId: 'claude',
    });
    expect(s.pendingInitialPrompt).toBeDefined();
    // The 8001st character and beyond must not appear.
    expect(s.pendingInitialPrompt).not.toContain('TAIL');
    // The truncation marker must be present.
    expect(s.pendingInitialPrompt).toContain('[note truncated]');
    // The first 8000 chars must be present.
    expect(s.pendingInitialPrompt).toContain('A'.repeat(8000));
  });

  it('does not append [note truncated] when content is exactly 8000 chars', () => {
    const exact = 'A'.repeat(8000);
    const s = buildNoteSession({
      noteId: 'Notes/Exact.md',
      noteTitle: 'Exact',
      noteContent: exact,
      providerId: 'claude',
    });
    expect(s.pendingInitialPrompt).not.toContain('[note truncated]');
  });

  it('includes proper prompt structure with headers and footers', () => {
    const s = buildNoteSession({
      noteId: 'Notes/Test.md',
      noteTitle: 'Test',
      noteContent: 'test content',
      providerId: 'claude',
    });
    expect(s.pendingInitialPrompt).toContain('You are being launched from a note');
    expect(s.pendingInitialPrompt).toContain('Note path: Notes/Test.md');
    expect(s.pendingInitialPrompt).toContain('--- NOTE CONTENT ---');
    expect(s.pendingInitialPrompt).toContain('--- END NOTE ---');
    expect(s.pendingInitialPrompt).toContain('summarizing what you understand');
  });

  it('generates unique id and createdAt when not provided', () => {
    const s1 = buildNoteSession({
      noteId: 'Notes/A.md',
      noteTitle: 'A',
      noteContent: 'content',
      providerId: 'claude',
    });
    const s2 = buildNoteSession({
      noteId: 'Notes/B.md',
      noteTitle: 'B',
      noteContent: 'content',
      providerId: 'claude',
    });
    expect(s1.id).not.toBe(s2.id);
    expect(s1.createdAt).toBeDefined();
    expect(s2.createdAt).toBeDefined();
  });

  it('respects provided id and createdAt', () => {
    const customId = 'my-custom-id';
    const customTime = '2026-06-10T12:00:00.000Z';
    const s = buildNoteSession({
      noteId: 'Notes/Test.md',
      noteTitle: 'Test',
      noteContent: 'content',
      providerId: 'claude',
      id: customId,
      createdAt: customTime,
    });
    expect(s.id).toBe(customId);
    expect(s.createdAt).toBe(customTime);
  });

  it('sets cliSessionId to null', () => {
    const s = buildNoteSession({
      noteId: 'Notes/Test.md',
      noteTitle: 'Test',
      noteContent: 'content',
      providerId: 'claude',
    });
    expect(s.cliSessionId).toBeNull();
  });
});

describe('buildCliSession', () => {
  it('stores the account when given and omits the key otherwise', () => {
    expect(buildCliSession({ name: 'S', providerId: 'codex', account: 'personal' }).account).toBe('personal');
    expect('account' in buildCliSession({ name: 'S', providerId: 'codex' })).toBe(false);
  });
});
