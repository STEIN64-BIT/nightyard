import type { NightyardApi } from './types.js';
import { mergeDefaultArgs } from '../shared/args-utils.js';
import type { SessionRecord, ProjectRecord, Preferences, PersistedState, ArchivedSession, ProviderId, CostInfo, ContextWindowInfo, InitialContextSnapshot, ReadinessResult, ReadinessSnapshot, TeamMember, TeamData, OverviewLayout } from '../shared/types.js';
import { getCost } from './session-cost.js';
import { getProviderCapabilities, getProviderAvailabilitySnapshot } from './provider-availability.js';
import { basename } from '../shared/platform.js';
import { isCliSession } from './session-utils.js';
import { archiveSession as archiveSessionPure } from './state/session-archive.js';
import {
  buildResumedSession,
  buildResumedSessionFromCliId,
  clearSessionHistory as clearSessionHistoryPure,
  findCliSessionTab,
  getSessionHistory as getSessionHistoryPure,
  removeHistoryEntry as removeHistoryEntryPure,
  resolveResumeSource,
  toggleBookmark as toggleBookmarkPure,
} from './state/session-history.js';
import {
  attachSessionToProject,
  buildBrowserTabSession,
  buildCliSession,
  buildCounselSession,
  buildDiffViewerSession,
  buildFileReaderSession,
  buildKanbanSession,
  buildMcpInspectorSession,
  buildNoteSession,
  buildProjectTabSession,
  buildRemoteSession,
  buildSleepySession,
  buildTeamSession,
} from './state/session-factory.js';
import { NavHistory } from './state/nav-history.js';
import { isPrimaryWindow } from './window-context.js';
import { createDefaultBoard, ensureProjectDefaults, hydrateLoadedState, serializeForSave } from './state/persistence.js';
import {
  applyMemberPatch,
  buildNewMember,
  buildTeamChatSession,
  fireAndForgetRemoveAgent,
  pickTeamChatProvider,
  reconcileAgent as reconcileAgentPure,
  removeMember,
  syncAgentInstall as syncAgentInstallPure,
} from './state/team-state.js';
import {
  browserTabNameFromUrl,
  buildPlanSessionArgs,
  findExistingBrowserTab,
  findExistingDiffViewer,
  findExistingFileReader,
  findExistingTabByType,
  resolveCliProvider,
  resolvePlanProvider,
} from './state/specialized-sessions.js';
import {
  addInsightSnapshot as addInsightSnapshotPure,
  dismissInsight as dismissInsightPure,
  isInsightDismissed as isInsightDismissedPure,
  setProjectReadiness as setProjectReadinessPure,
} from './state/insights-state.js';
import {
  collectRemovalIds,
  cycleSessionId,
  reorderSessionInProject,
  sessionIdAtIndex,
  toggleSwarmMode,
} from './state/layout-state.js';

export type { SessionRecord, ProjectRecord, Preferences, PersistedState, ArchivedSession } from '../shared/types.js';

// Session ids whose SLEEPY pane should auto-spawn on first render.
// One-shot: consumed and cleared by the pane the first time it reads.
export const sleepyAutoStartSessions = new Set<string>();

// Optional override prompt for the sleepy pane's goal text on auto-start.
// One-shot: consumed and cleared by the pane when it starts.
export const sleepyInitialPrompts = new Map<string, string>();
export const sleepyInitialArgs = new Map<string, string[]>();

export const MAX_SESSION_NAME_LENGTH = 60;
export const MAX_PROJECT_NAME_LENGTH = 80;

declare global {
  interface Window {
    nightyard: NightyardApi;
  }
}

type EventType =
  | 'project-added'
  | 'project-removed'
  | 'project-changed'
  | 'session-added'
  | 'session-removed'
  | 'session-changed'
  | 'layout-changed'
  | 'preferences-changed'
  | 'terminal-panel-changed'
  | 'history-changed'
  | 'insights-changed'
  | 'readiness-changed'
  | 'sidebar-toggled'
  | 'cli-session-cleared'
  | 'board-changed'
  | 'team-changed'
  | 'counsel-changed'
  | 'overview-layout-changed'
  | 'github-unread-changed'
  | 'state-loaded'
  | 'sleepy-goal-updated';

type EventCallback = (data?: unknown) => void;

const defaultPreferences: Preferences = {
  soundOnSessionWaiting: true,
  notificationsDesktop: true,
  debugMode: false,
  sessionHistoryEnabled: true,
  insightsEnabled: true,
  autoTitleEnabled: true,
  confirmCloseWorkingSession: true,
  copyOnSelect: false,
  zoomFactor: 1.0,
  readinessExcludedProviders: [],
  sidebarViews: { gitPanel: true, sessionHistory: true, costFooter: true, fileTree: true },
  boardCardMetrics: true,
  projectSortMode: 'recent',
};

class AppState {
  private state: PersistedState = { version: 1, projects: [], activeProjectId: null, preferences: { ...defaultPreferences } };
  private listeners = new Map<EventType, Set<EventCallback>>();
  private nav = new NavHistory();

  private pushNav(sessionId: string | null | undefined): void {
    this.nav.push(sessionId);
  }

  private pruneNav(sessionId: string): void {
    this.nav.prune(sessionId);
  }

  private findProjectBySession(sessionId: string): ProjectRecord | undefined {
    return this.state.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
  }

  /**
   * Stamp a project's last-used timestamp. This is the single choke point for the sidebar's
   * "recent" sort signal — called on session creation (commitNewSession) and on the two places a
   * project/session becomes active (setActiveProject, setActiveSession). Deliberately not called
   * on every pty byte (too hot) or on internal reuse/cycle paths that don't change which project
   * is the user's current focus.
   */
  private touchProjectUsage(project: ProjectRecord | undefined): void {
    if (project) project.lastUsedAt = Date.now();
  }

  navigateBack(): void {
    this.stepNav(-1);
  }

  navigateForward(): void {
    this.stepNav(1);
  }

  private stepNav(direction: 1 | -1): void {
    const id = this.nav.findNextValid(direction, (sid) => !!this.findProjectBySession(sid));
    if (!id) return;
    const project = this.findProjectBySession(id)!;
    this.nav.withSuppression(() => {
      const projectChanged = this.state.activeProjectId !== project.id;
      this.state.activeProjectId = project.id;
      project.activeSessionId = id;
      this.persist();
      if (projectChanged) this.emit('project-changed');
      this.emit('session-changed');
    });
  }

  on(event: EventType, cb: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  private emit(event: EventType, data?: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  async load(): Promise<void> {
    const loaded = (await window.nightyard.store.load()) as PersistedState | null;
    if (loaded && loaded.version === 1) {
      this.state = loaded;
      hydrateLoadedState(this.state, defaultPreferences);
    }
    ensureProjectDefaults(this.state);

    // Migration: default globalDefaultArgs for users coming from pre-Plan-5 builds
    if (this.preferences.globalDefaultArgs === undefined) {
      this.preferences.globalDefaultArgs = '--dangerously-skip-permissions';
    }

    if (!this.state.starPromptDismissed && isPrimaryWindow()) {
      this.state.appLaunchCount = (this.state.appLaunchCount ?? 0) + 1;
      this.persist();
    }

    this.emit('state-loaded');
  }

  private persist(): void {
    window.nightyard.store.save(serializeForSave(this.state));
  }

  /** Replace state with a snapshot pushed from another window. Main already persisted it — do not save or re-broadcast. */
  applyExternalSnapshot(snap: PersistedState): void {
    this.state = snap;
    hydrateLoadedState(this.state, defaultPreferences);
    ensureProjectDefaults(this.state);
    this.emit('state-loaded');
  }

  findSessionWithProject(sessionId: string): { project: ProjectRecord; session: SessionRecord } | undefined {
    for (const project of this.state.projects) {
      const session = project.sessions.find((s) => s.id === sessionId);
      if (session) return { project, session };
    }
    return undefined;
  }

  get projects(): ProjectRecord[] {
    return this.state.projects;
  }

  get activeProjectId(): string | null {
    return this.state.activeProjectId;
  }

  get activeProject(): ProjectRecord | undefined {
    return this.state.projects.find((p) => p.id === this.state.activeProjectId);
  }

  get activeSession(): SessionRecord | undefined {
    const project = this.activeProject;
    if (!project) return undefined;
    return project.sessions.find((s) => s.id === project.activeSessionId);
  }

  get sidebarWidth(): number | undefined {
    return this.state.sidebarWidth;
  }

  setSidebarWidth(width: number): void {
    this.state.sidebarWidth = width;
    this.persist();
  }

  get sidebarCollapsed(): boolean {
    return this.state.sidebarCollapsed ?? false;
  }

  toggleSidebar(): void {
    this.state.sidebarCollapsed = !this.sidebarCollapsed;
    this.persist();
    this.emit('sidebar-toggled');
  }

  setTerminalPanelOpen(open: boolean): void {
    const project = this.activeProject;
    if (!project) return;
    project.terminalPanelOpen = open;
    this.persist();
    this.emit('terminal-panel-changed');
  }

  setTerminalPanelHeight(height: number): void {
    const project = this.activeProject;
    if (!project) return;
    project.terminalPanelHeight = height;
    this.persist();
  }

  get lastSeenVersion(): string | undefined {
    return this.state.lastSeenVersion;
  }

  setLastSeenVersion(version: string): void {
    this.state.lastSeenVersion = version;
    this.persist();
  }

  get appLaunchCount(): number {
    return this.state.appLaunchCount ?? 0;
  }

  get starPromptDismissed(): boolean {
    return this.state.starPromptDismissed ?? false;
  }

  dismissStarPrompt(): void {
    this.state.starPromptDismissed = true;
    this.persist();
  }

  get preferences(): Preferences {
    return this.state.preferences;
  }

  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    this.state.preferences[key] = value;
    this.persist();
    this.emit('preferences-changed');
  }

  setActiveProject(id: string | null): void {
    this.state.activeProjectId = id;
    const project = this.state.projects.find((p) => p.id === id);
    this.touchProjectUsage(project);
    if (project?.activeSessionId) this.pushNav(project.activeSessionId);
    this.persist();
    this.emit('project-changed');
  }

  addProject(name: string, path: string): ProjectRecord {
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name,
      path,
      sessions: [],
      activeSessionId: null,
      layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
      board: createDefaultBoard(),
    };
    this.state.projects.push(project);
    this.state.activeProjectId = project.id;
    this.persist();
    this.emit('project-added', project);
    this.emit('project-changed');
    return project;
  }

  removeProject(id: string): void {
    const project = this.state.projects.find((p) => p.id === id);
    const sessions = project?.sessions ?? [];

    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    if (this.state.activeProjectId === id) {
      this.state.activeProjectId = this.state.projects[0]?.id ?? null;
    }
    this.persist();
    for (const session of sessions) {
      this.emit('session-removed', { projectId: id, sessionId: session.id });
    }
    this.emit('project-removed', id);
    this.emit('project-changed');
  }

  renameProject(id: string, name: string): void {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) return;
    project.name = trimmed.slice(0, MAX_PROJECT_NAME_LENGTH);
    this.persist();
    this.emit('project-changed');
  }

  addPlanSession(
    projectId: string,
    name: string,
    planMode: boolean = true,
    providerIdOverride?: ProviderId,
  ): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const providerId = resolvePlanProvider(project, this.state.preferences, providerIdOverride);
    const args = buildPlanSessionArgs(this.preferences.globalDefaultArgs ?? '', project, getProviderCapabilities(providerId), planMode);
    return this.addSession(projectId, name, args, providerId);
  }

  addSession(projectId: string, name: string, args?: string, providerId?: ProviderId, account?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const resolvedProvider = resolveCliProvider(this.state.preferences, providerId);
    const session = buildCliSession({
      name,
      providerId: resolvedProvider,
      args: args ?? (mergeDefaultArgs(this.preferences.globalDefaultArgs, project.defaultArgs) || undefined),
      // Only Codex knows about accounts (CODEX_HOME dirs); other providers ignore it.
      account: resolvedProvider === 'codex' ? (account ?? project.defaultAccount) : undefined,
    });
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  private activateExistingSession(project: ProjectRecord, existing: SessionRecord): SessionRecord {
    if (project.activeSessionId !== existing.id) {
      project.activeSessionId = existing.id;
      this.pushNav(existing.id);
      this.persist();
      this.emit('session-changed');
    }
    return existing;
  }

  private commitNewSession(projectId: string, session: SessionRecord): void {
    this.touchProjectUsage(this.state.projects.find((p) => p.id === projectId));
    this.pushNav(session.id);
    this.persist();
    this.emit('session-added', { projectId, session });
    this.emit('session-changed');
  }

  addDiffViewerSession(projectId: string, filePath: string, area: string, worktreePath?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const existing = findExistingDiffViewer(project, filePath, area, worktreePath);
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildDiffViewerSession({ name: basename(filePath), filePath, area, worktreePath });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addRemoteSession(projectId: string, sessionId: string, hostSessionName: string, shareMode: 'readonly' | 'readwrite'): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const session = buildRemoteSession({ id: sessionId, name: `Remote: ${hostSessionName}`, remoteHostName: hostSessionName, shareMode });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addBrowserTabSession(projectId: string, url?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (url) {
      const existing = findExistingBrowserTab(project, url);
      if (existing) return this.activateExistingSession(project, existing);
    }

    const session = buildBrowserTabSession({ name: browserTabNameFromUrl(url), url });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openProjectTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'project-tab');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildProjectTabSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openKanbanTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (!project.board) project.board = createDefaultBoard();

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'kanban');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildKanbanSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openTeamTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'team');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildTeamSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openCounselTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'counsel');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildCounselSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openSleepyTab(projectId: string, opts?: { autoStart?: boolean; goalText?: string; args?: string[] }): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'sleepy');
    if (existing) {
      if (opts?.args) sleepyInitialArgs.set(existing.id, opts.args);
      if (opts?.autoStart) sleepyAutoStartSessions.add(existing.id);
      if (opts?.goalText) sleepyInitialPrompts.set(existing.id, opts.goalText);
      // Notify the already-mounted pane so it can consume the new goal + auto-start.
      if (opts?.autoStart || opts?.goalText) {
        this.emit('sleepy-goal-updated', { sessionId: existing.id });
      }
      return this.activateExistingSession(project, existing);
    }

    const session = buildSleepySession({ projectName: project.name });
    if (opts?.args) sleepyInitialArgs.set(session.id, opts.args);
    if (opts?.autoStart) sleepyAutoStartSessions.add(session.id);
    if (opts?.goalText) sleepyInitialPrompts.set(session.id, opts.goalText);
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  get team(): TeamData {
    if (!this.state.team) this.state.team = { members: [] };
    return this.state.team;
  }

  getTeamMembers(): TeamMember[] {
    return this.team.members;
  }

  addTeamMember(input: Omit<TeamMember, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TeamMember {
    const member = buildNewMember(input);
    this.team.members.push(member);
    this.persist();
    this.emit('team-changed');
    if (member.installAsAgent) {
      void syncAgentInstallPure(window.nightyard.provider, this.team, member, () => this.persist());
    }
    return member;
  }

  updateTeamMember(id: string, patch: Partial<Omit<TeamMember, 'id' | 'createdAt'>>): TeamMember | undefined {
    const result = applyMemberPatch(this.team, id, patch);
    if (!result) return undefined;
    this.persist();
    this.emit('team-changed');
    void reconcileAgentPure(window.nightyard.provider, this.team, result.before, result.after, () => this.persist());
    return result.after;
  }

  removeTeamMember(id: string): void {
    const removed = removeMember(this.team, id);
    if (!removed) return;
    this.persist();
    this.emit('team-changed');
    if (removed.installAsAgent && removed.agentSlug) {
      fireAndForgetRemoveAgent(window.nightyard.provider, removed.agentSlug);
    }
  }

  setTeamPredefinedCache(suggestions: TeamMember[]): void {
    this.team.predefinedCache = { fetchedAt: Date.now(), suggestions };
    this.persist();
  }

  notifyTeamChanged(): void {
    this.persist();
    this.emit('team-changed');
  }

  notifyCounselChanged(): void {
    this.persist();
    this.emit('counsel-changed');
  }

  startTeamChat(
    projectId: string,
    member: TeamMember,
    overrideProviderId?: ProviderId,
  ): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const activeSession = project.sessions.find((s) => s.id === project.activeSessionId);
    const providerId = pickTeamChatProvider(activeSession, this.state.preferences.defaultProvider, overrideProviderId);
    if (!providerId) return undefined;

    const session = buildTeamChatSession(project, member, providerId, MAX_SESSION_NAME_LENGTH, this.preferences.globalDefaultArgs ?? '');
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  consumePendingSystemPrompt(projectId: string, sessionId: string): string | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    const session = project?.sessions.find((s) => s.id === sessionId);
    if (!session?.pendingSystemPrompt) return undefined;
    const prompt = session.pendingSystemPrompt;
    delete session.pendingSystemPrompt;
    return prompt;
  }

  addFileReaderSession(projectId: string, filePath: string, lineNumber?: number): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const existing = findExistingFileReader(project, filePath);
    if (existing) {
      const lineChanged = existing.fileReaderLine !== lineNumber;
      const activating = project.activeSessionId !== existing.id;
      existing.fileReaderLine = lineNumber;
      if (activating) {
        project.activeSessionId = existing.id;
        this.pushNav(existing.id);
      }
      // Emit even when the tab is already active so renderLayout re-runs
      // setFileReaderLine and scrolls to the new position.
      if (activating || lineChanged) {
        this.persist();
        this.emit('session-changed');
      }
      return existing;
    }

    const session = buildFileReaderSession({ name: basename(filePath), filePath, lineNumber });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addMcpInspectorSession(projectId: string, name: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const session = buildMcpInspectorSession({ name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addNoteSession(projectId: string, noteId: string, noteTitle: string, noteContent: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const providerId = resolveCliProvider(this.state.preferences, undefined);
    const session = buildNoteSession({ noteId, noteTitle, noteContent, providerId });
    // addToSwarm: true so the new tab appears in swarm-mode layouts
    attachSessionToProject(project, session, { addToSwarm: true });
    // commitNewSession emits 'session-added' synchronously while pendingInitialPrompt
    // is still in-memory (persist() strips it, but split-layout.onSessionAdded reads
    // it before the event returns — identical pattern to resumeWithProvider).
    this.commitNewSession(projectId, session);
    return session;
  }

  removeSession(projectId: string, sessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    // Archive CLI sessions before removing (cost data must be captured before session-removed triggers destroyTerminal)
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session && isCliSession(session) && this.state.preferences.sessionHistoryEnabled) {
      // Skip archiving empty sessions (no CLI activity)
      if (session.cliSessionId || getCost(session.id) !== null) {
        this.archiveSession(project, session);
      }
    }

    const closingIndex = project.sessions.findIndex((s) => s.id === sessionId);
    project.sessions = project.sessions.filter((s) => s.id !== sessionId);
    this.pruneNav(sessionId);
    if (project.activeSessionId === sessionId) {
      const newIndex = closingIndex > 0 ? closingIndex - 1 : 0;
      project.activeSessionId = project.sessions[newIndex]?.id ?? null;
      if (project.activeSessionId) this.pushNav(project.activeSessionId);
    }
    // Also remove from split/swarm panes
    project.layout.splitPanes = project.layout.splitPanes.filter((id) => id !== sessionId);
    this.persist();
    this.emit('session-removed', { projectId, sessionId });
    this.emit('session-changed');
  }

  private archiveSession(project: ProjectRecord, session: SessionRecord): void {
    archiveSessionPure(project, session);
    this.emit('history-changed', project.id);
  }

  getSessionHistory(projectId: string): ArchivedSession[] {
    return getSessionHistoryPure(this.state.projects.find((p) => p.id === projectId));
  }

  removeHistoryEntry(projectId: string, archivedSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!removeHistoryEntryPure(project, archivedSessionId)) return;
    this.persist();
    this.emit('history-changed', projectId);
  }

  toggleBookmark(projectId: string, archivedSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!toggleBookmarkPure(project, archivedSessionId)) return;
    this.persist();
    this.emit('history-changed', projectId);
  }

  clearSessionHistory(projectId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    clearSessionHistoryPure(project);
    this.persist();
    this.emit('history-changed', projectId);
  }

  resumeFromHistory(projectId: string, archivedSessionId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const archived = project.sessionHistory?.find((a) => a.id === archivedSessionId);
    if (!archived || !archived.cliSessionId) return undefined;

    const existing = findCliSessionTab(project, archived.cliSessionId);
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildResumedSession(archived);
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  /** Open a CLI session by cliSessionId, bypassing Nightyard history. Used for cross-project deep search results. */
  openCliSession(projectId: string, cliSessionId: string, name: string, providerId: ProviderId = 'claude', account?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const existing = findCliSessionTab(project, cliSessionId);
    if (existing) return this.activateExistingSession(project, existing);

    // Sessions resumed from search results don't know their account; the
    // archive entry for the same Codex session id does.
    const resolvedAccount = account
      ?? project.sessionHistory?.find((a) => a.cliSessionId === cliSessionId)?.account;
    const session = buildResumedSessionFromCliId(cliSessionId, name, providerId, resolvedAccount);
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  async resumeWithProvider(
    projectId: string,
    source: { archivedSessionId?: string; sessionId?: string },
    targetProviderId: ProviderId,
  ): Promise<SessionRecord | undefined> {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    // Defense-in-depth: UI gates this by availability, but bail if the target
    // provider isn't actually installed so we don't create a broken session.
    const snapshot = getProviderAvailabilitySnapshot();
    if (snapshot && snapshot.availability.get(targetProviderId) === false) {
      return undefined;
    }

    const resolved = resolveResumeSource(project, source);
    if (!resolved) return undefined;

    const initialPrompt = await window.nightyard.session.buildResumeWithPrompt(
      resolved.providerId,
      resolved.cliSessionId ?? null,
      project.path,
      resolved.name,
    );

    const session: SessionRecord = {
      ...buildCliSession({
        name: `${resolved.name} (↪ ${targetProviderId})`,
        providerId: targetProviderId,
        account: targetProviderId === 'codex' ? resolved.account : undefined,
      }),
      pendingInitialPrompt: initialPrompt,
    };
    attachSessionToProject(project, session, { addToSwarm: true });
    // commitNewSession persist()s before emitting session-added; persist strips
    // the transient pendingInitialPrompt, but split-layout.onSessionAdded reads
    // it from in-memory state synchronously inside the emit.
    this.commitNewSession(projectId, session);
    return session;
  }

  consumePendingInitialPrompt(projectId: string, sessionId: string): string | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    const session = project?.sessions.find((s) => s.id === sessionId);
    if (!session?.pendingInitialPrompt) return undefined;
    const prompt = session.pendingInitialPrompt;
    delete session.pendingInitialPrompt;
    return prompt;
  }

  setActiveSession(projectId: string, sessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    this.touchProjectUsage(project);
    project.activeSessionId = sessionId;
    this.pushNav(sessionId);
    this.persist();
    this.emit('session-changed');
  }

  updateSessionCliId(projectId: string, sessionId: string, cliSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const session = project.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    // If session already had a different cliSessionId (e.g., /clear was used),
    // archive the previous session and reset the tab name
    if (session.cliSessionId && session.cliSessionId !== cliSessionId) {
      this.archiveSession(project, session);
      session.name = `Session ${project.sessions.length + (project.sessionHistory?.length || 0)}`;
      session.userRenamed = false;
      this.emit('cli-session-cleared', { sessionId });
    }

    session.cliSessionId = cliSessionId;
    this.persist();
    this.emit('session-changed');
  }

  /** @deprecated Use updateSessionCliId */
  updateSessionClaudeId(projectId: string, sessionId: string, claudeSessionId: string): void {
    this.updateSessionCliId(projectId, sessionId, claudeSessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.findSessionById(sessionId) !== undefined;
  }

  private findSessionById(sessionId: string): SessionRecord | undefined {
    for (const project of this.state.projects) {
      const session = project.sessions.find((s) => s.id === sessionId);
      if (session) return session;
    }
    return undefined;
  }

  updateSessionCost(sessionId: string, cost: CostInfo): void {
    const session = this.findSessionById(sessionId);
    if (!session) return;
    session.cost = { ...cost };
    this.persist();
  }

  updateSessionContext(sessionId: string, context: ContextWindowInfo): void {
    const session = this.findSessionById(sessionId);
    if (!session) return;
    session.contextWindow = { ...context };
    this.persist();
  }

  updateSessionBrowserTabUrl(sessionId: string, url: string): void {
    const session = this.findSessionById(sessionId);
    if (!session || session.browserTabUrl === url) return;
    session.browserTabUrl = url;
    this.persist();
  }

  renameSession(projectId: string, sessionId: string, name: string, userRenamed?: boolean): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const session = project.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.type === 'kanban' || session.type === 'project-tab') return;
    session.name = name.slice(0, MAX_SESSION_NAME_LENGTH);
    if (userRenamed) session.userRenamed = true;
    // Keep history entry in sync if this session was resumed from history
    if (session.cliSessionId && project.sessionHistory) {
      const historyEntry = project.sessionHistory.find((a) => a.cliSessionId === session.cliSessionId);
      if (historyEntry) {
        historyEntry.name = session.name;
        this.emit('history-changed', project.id);
      }
    }
    this.persist();
    this.emit('session-renamed', { projectId, sessionId, name: session.name });
    this.emit('session-changed');
  }

  notifyBoardChanged(): void {
    this.persist();
    this.emit('board-changed');
  }

  toggleSplit(): void {
    this.toggleSwarm();
  }

  toggleSwarm(): void {
    const project = this.activeProject;
    if (!project) return;
    toggleSwarmMode(project);
    this.persist();
    this.emit('layout-changed');
  }

  cycleSession(direction: 1 | -1): void {
    const project = this.activeProject;
    if (!project) return;
    const next = cycleSessionId(project, direction);
    if (!next) return;
    project.activeSessionId = next;
    this.pushNav(next);
    this.persist();
    this.emit('session-changed');
  }

  gotoSession(index: number): void {
    const project = this.activeProject;
    if (!project) return;
    const next = sessionIdAtIndex(project, index);
    if (!next) return;
    project.activeSessionId = next;
    this.pushNav(next);
    this.persist();
    this.emit('session-changed');
  }

  removeAllSessions(projectId: string): void {
    this.batchRemoveSessions(projectId, 'all');
  }

  removeSessionsFromRight(projectId: string, sessionId: string): void {
    this.batchRemoveSessions(projectId, 'right', sessionId);
  }

  removeSessionsFromLeft(projectId: string, sessionId: string): void {
    this.batchRemoveSessions(projectId, 'left', sessionId);
  }

  removeOtherSessions(projectId: string, sessionId: string): void {
    this.batchRemoveSessions(projectId, 'others', sessionId);
  }

  private batchRemoveSessions(projectId: string, mode: 'all' | 'right' | 'left' | 'others', anchorSessionId?: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const ids = collectRemovalIds(project, mode, anchorSessionId);
    for (const id of ids) this.removeSession(projectId, id);
  }

  addInsightSnapshot(projectId: string, snapshot: InitialContextSnapshot): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    addInsightSnapshotPure(project, snapshot);
    this.persist();
    this.emit('insights-changed', projectId);
  }

  dismissInsight(projectId: string, insightId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    dismissInsightPure(project, insightId);
    this.persist();
    this.emit('insights-changed', projectId);
  }

  isInsightDismissed(projectId: string, insightId: string): boolean {
    return isInsightDismissedPure(this.state.projects.find((p) => p.id === projectId), insightId);
  }

  setProjectReadiness(projectId: string, result: ReadinessResult): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    setProjectReadinessPure(project, result);
    this.persist();
    this.emit('readiness-changed', projectId);
  }

  setProjectOverviewLayout(projectId: string, layout: OverviewLayout): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    project.overviewLayout = layout;
    this.persist();
    this.emit('overview-layout-changed', projectId);
  }

  /** App-scoped cross-project ("All Projects") overview layout, if the user has one. */
  get globalOverview(): OverviewLayout | undefined {
    return this.state.globalOverview;
  }

  /**
   * Persist the app-scoped cross-project overview layout. Purely additive:
   * writes the optional top-level `globalOverview` field via the same
   * `persist()` save path every other mutator uses. Does not touch any
   * per-project state.
   */
  setGlobalOverview(layout: OverviewLayout): void {
    this.state.globalOverview = layout;
    this.persist();
    this.emit('overview-layout-changed', null);
  }

  getProjectDefaultDirection(projectId: string): string | undefined {
    return this.state.projects.find((p) => p.id === projectId)?.wakeyDefaultDirection;
  }

  setProjectDefaultDirection(projectId: string, direction: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const trimmed = direction.trim();
    if (trimmed) {
      project.wakeyDefaultDirection = trimmed;
    } else {
      delete project.wakeyDefaultDirection;
    }
    this.persist();
    this.emit('project-changed');
  }

  setGithubItemSeen(projectId: string, itemId: string, isoTimestamp: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!project.githubLastSeen) project.githubLastSeen = {};
    project.githubLastSeen[itemId] = isoTimestamp;
    this.persist();
    this.emit('github-unread-changed', projectId);
  }

  setGithubItemsSeenBulk(projectId: string, entries: Record<string, string>): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!project.githubLastSeen) project.githubLastSeen = {};
    let changed = false;
    for (const [id, ts] of Object.entries(entries)) {
      if (project.githubLastSeen[id] !== ts) {
        project.githubLastSeen[id] = ts;
        changed = true;
      }
    }
    if (!changed) return;
    this.persist();
    this.emit('github-unread-changed', projectId);
  }

  getGithubLastSeen(projectId: string, itemId: string): string | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    return project?.githubLastSeen?.[itemId];
  }

  reorderSession(projectId: string, sessionId: string, toIndex: number): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!reorderSessionInProject(project, sessionId, toIndex)) return;
    this.persist();
    this.emit('session-changed');
  }
}

export { createDefaultBoard };

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  (appState as any)['state'] = { version: 1, projects: [], activeProjectId: null, preferences: { ...defaultPreferences } };
  (appState as any)['listeners'] = new Map();
  (appState as any)['nav'] = new NavHistory();
}

export const appState = new AppState();
