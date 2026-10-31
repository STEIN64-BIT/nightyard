import type { ProjectRecord, ProviderId, SessionRecord } from '../../shared/types.js';

interface BaseOpts {
  id?: string;
  createdAt?: string;
}

export function buildCliSession(opts: BaseOpts & { name: string; providerId: ProviderId; args?: string; account?: string }): SessionRecord {
  const { name, providerId, args, account, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    providerId,
    ...(args ? { args } : {}),
    ...(account ? { account } : {}),
    cliSessionId: null,
    createdAt,
  };
}

export function buildDiffViewerSession(opts: BaseOpts & { name: string; filePath: string; area: string; worktreePath?: string }): SessionRecord {
  const { name, filePath, area, worktreePath, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'diff-viewer',
    diffFilePath: filePath,
    diffArea: area,
    ...(worktreePath ? { worktreePath } : {}),
    cliSessionId: null,
    createdAt,
  };
}

export function buildRemoteSession(opts: BaseOpts & { id: string; name: string; remoteHostName: string; shareMode: 'readonly' | 'readwrite' }): SessionRecord {
  const { id, name, remoteHostName, shareMode, createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'remote-terminal',
    remoteHostName,
    shareMode,
    cliSessionId: null,
    createdAt,
  };
}

export function buildBrowserTabSession(opts: BaseOpts & { name: string; url?: string }): SessionRecord {
  const { name, url, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'browser-tab',
    browserTabUrl: url,
    cliSessionId: null,
    createdAt,
  };
}

export function buildProjectTabSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - Overview`,
    type: 'project-tab',
    cliSessionId: null,
    createdAt,
  };
}

export function buildKanbanSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - Kanban`,
    type: 'kanban',
    cliSessionId: null,
    createdAt,
  };
}

export function buildTeamSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - Team`,
    type: 'team',
    cliSessionId: null,
    createdAt,
  };
}

export function buildCounselSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: 'Counsel',
    type: 'counsel',
    cliSessionId: null,
    createdAt,
  };
}

export function buildSleepySession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - SLEEPY`,
    type: 'sleepy',
    cliSessionId: null,
    createdAt,
  };
}

export function buildFileReaderSession(opts: BaseOpts & { name: string; filePath: string; lineNumber?: number }): SessionRecord {
  const { name, filePath, lineNumber, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'file-reader',
    fileReaderPath: filePath,
    ...(lineNumber !== undefined ? { fileReaderLine: lineNumber } : {}),
    cliSessionId: null,
    createdAt,
  };
}

export function buildMcpInspectorSession(opts: BaseOpts & { name: string }): SessionRecord {
  const { name, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'mcp-inspector',
    cliSessionId: null,
    createdAt,
  };
}

export function buildNoteSession(opts: BaseOpts & {
  noteId: string; noteTitle: string; noteContent: string; providerId: ProviderId;
}): SessionRecord {
  const { noteId, noteTitle, noteContent, providerId, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  const truncated = noteContent.length > 8000;
  const body = truncated ? noteContent.slice(0, 8000) + '\n[note truncated]' : noteContent;
  return {
    id,
    name: `📝 ${noteTitle}`,
    providerId,
    cliSessionId: null,
    createdAt,
    sourceNoteId: noteId,
    pendingInitialPrompt:
      `You are being launched from a note in my Obsidian knowledge vault.\n` +
      `Note path: ${noteId}\n\n--- NOTE CONTENT ---\n${body}\n--- END NOTE ---\n\n` +
      `Read it, then help me act on it: continue the work it describes, answer its open questions, or expand it. Start by summarizing what you understand and proposing the next concrete step.`,
  };
}

/**
 * Append a session to a project, mark it active, and (when in swarm mode)
 * add it to the swarm panes. Does not call persist() or emit events — those
 * remain the caller's responsibility.
 */
export function attachSessionToProject(
  project: ProjectRecord,
  session: SessionRecord,
  opts: { addToSwarm?: boolean } = {},
): SessionRecord {
  project.sessions.push(session);
  project.activeSessionId = session.id;
  if (opts.addToSwarm && project.layout.mode === 'swarm') {
    project.layout.splitPanes.push(session.id);
  }
  return session;
}
