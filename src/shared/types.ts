// Shared type definitions used across main, preload, and renderer processes.

import type { TeamDomain } from './team-config.js';

export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 2.0;

// --- Provider ---

export type ProviderId = 'claude' | 'codex' | 'copilot' | 'gemini' | 'kimi';
export type PendingPromptTrigger = 'session-start' | 'first-output' | 'startup-arg';

export interface CliProviderCapabilities {
  sessionResume: boolean;
  costTracking: boolean;
  contextWindow: boolean;
  hookStatus: boolean;
  configReading: boolean;
  shiftEnterNewline: boolean;
  pendingPromptTrigger: PendingPromptTrigger;
  planModeArg?: string;
  systemPromptInjection: boolean;
}

export interface CliProviderMeta {
  id: ProviderId;
  displayName: string;
  binaryName: string;
  capabilities: CliProviderCapabilities;
  defaultContextWindowSize: number;
}

// --- Git ---

export interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  isBare: boolean;
}

export interface GitFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  area: 'staged' | 'working' | 'untracked' | 'conflicted';
}

// --- Provider Config ---

export interface McpServer { name: string; url: string; status: string; scope: 'user' | 'project'; filePath: string }
export interface Agent { name: string; model: string; category: 'plugin' | 'built-in'; scope: 'user' | 'project'; filePath: string }
export interface Skill { name: string; description: string; scope: 'user' | 'project'; filePath: string }
export interface Command { name: string; description: string; scope: 'user' | 'project'; filePath: string }
export interface ProviderConfig { mcpServers: McpServer[]; agents: Agent[]; skills: Skill[]; commands: Command[] }
export type ClaudeConfig = ProviderConfig;

/** A Codex CLI login, identified by its CODEX_HOME directory. `default` = ~/.codex; `<id>` = ~/.codex-<id>. */
export interface CodexAccount { id: string; label: string; home: string }

// --- Cost / Context (shared with renderer modules) ---

export interface CostInfo {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  model?: string;
}

export interface ContextWindowInfo {
  totalTokens: number;
  contextWindowSize: number;
  usedPercentage: number;
}

// --- Session / State ---

export type SessionType =
  | 'mcp-inspector'
  | 'diff-viewer'
  | 'file-reader'
  | 'remote-terminal'
  | 'browser-tab'
  | 'project-tab'
  | 'kanban'
  | 'team'
  | 'counsel'
  | 'sleepy';

export interface SessionRecord {
  id: string;
  name: string;
  type?: SessionType;
  providerId?: ProviderId;
  args?: string;
  /** Provider login to use (Codex: CODEX_HOME account id, see codex-homes.ts). Absent = default. */
  account?: string;
  cliSessionId: string | null;
  mcpServerUrl?: string;
  diffFilePath?: string;
  diffArea?: string;
  worktreePath?: string;
  fileReaderPath?: string;
  fileReaderLine?: number;
  createdAt: string;
  userRenamed?: boolean;
  cost?: CostInfo;
  contextWindow?: ContextWindowInfo;
  remoteHostName?: string;
  shareMode?: 'readonly' | 'readwrite';
  browserTabUrl?: string;
  /** Persisted: identifies which TeamMember spawned this session, if any. */
  teamMemberId?: string;
  /** Persisted: vault note this session was launched from (knowledge graph). */
  sourceNoteId?: string;
  /** Transient: initial prompt to inject on first spawn. Not persisted. */
  pendingInitialPrompt?: string;
  /** Transient: system prompt to attach on first spawn. Not persisted (resume must not re-inject). */
  pendingSystemPrompt?: string;
}

// --- Team ---

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  description?: string;
  domain?: TeamDomain;
  systemPrompt: string;
  source: 'predefined' | 'custom';
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  /** When true, member is mirrored as a CLI-provider agent file at ~/.<cli>/agents/<slug>.md. */
  installAsAgent?: boolean;
  /** Sticky slug assigned on first install; preserved across renames so the right file is removed. */
  agentSlug?: string;
  /** Preferred counsel debate engine; seat toggle defaults to it (else 'claude'). */
  counselEngine?: CounselEngine;
  /** Model alias/id passed as --model for this persona's turns (e.g. 'sonnet'); CLI default when absent. */
  counselModel?: string;
}

export interface TeamData {
  members: TeamMember[];
  predefinedCache?: { fetchedAt: number; suggestions: TeamMember[] };
}

export interface ArchivedSession {
  id: string;
  name: string;
  providerId: ProviderId;
  account?: string;
  cliSessionId: string | null;
  createdAt: string;
  closedAt: string;
  bookmarked?: boolean;
  teamMemberId?: string;
  cost: {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
  } | null;
}

export interface InitialContextSnapshot {
  sessionId: string;
  timestamp: string;
  totalTokens: number;
  contextWindowSize: number;
  usedPercentage: number;
}

export interface DeepSearchResult {
  providerId: ProviderId;
  cliSessionId: string;
  projectSlug: string;
  projectCwd: string;
  snippet: string;
  score: number;
  /** Title derived from the first user message — fallback when Nightyard has no name for this session. */
  derivedName?: string;
}

export interface ProjectInsightsData {
  initialContextSnapshots: InitialContextSnapshot[];
  dismissed: string[];
}

// --- Counsel ---

export type CounselSeat = 'A' | 'B' | 'C';
export const COUNSEL_SEATS: CounselSeat[] = ['A', 'B', 'C'];
export type CounselEngine = 'claude' | 'codex';
export type CounselStyle = 'punchy' | 'balanced' | 'thorough';

export interface CounselSeatConfig {
  memberId: string;
  /** Denormalized so history renders after a member is deleted. */
  memberName: string;
  memberRole: string;
  providerId: CounselEngine;
  /** --model for this seat's turns; CLI default when absent. */
  model?: string;
}

export interface CounselTurnRecord {
  turnId: string;
  seat: CounselSeat;
  /** 1-based; one round = all three seats spoke once. */
  round: number;
  text: string;
}

export type CounselModeratorDecision = 'continue' | 'converged' | 'redirect';

export interface CounselModeratorNote {
  afterRound: number;
  decision: CounselModeratorDecision;
  note: string;
}

export interface CounselVerdict {
  agreedPoints: string[];
  disagreements: Array<{
    topic: string;
    positions: Record<CounselSeat, string>;
    adjudicatorLean: CounselSeat | 'none';
    rationale: string;
  }>;
  recommendation: string;
  openQuestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface CounselResult {
  counselId: string;
  prompt: string;
  seats: Record<CounselSeat, CounselSeatConfig>;
  contextBrief?: string;
  style: CounselStyle;
  turns: CounselTurnRecord[];
  moderatorNotes: CounselModeratorNote[];
  stoppedReason: 'converged' | 'max-turns' | 'stopped' | 'error';
  verdict?: CounselVerdict;
  startedAt: number;
  finishedAt?: number;
}

export interface CounselStartConfig {
  counselId: string;
  projectPath: string;
  prompt: string;
  seats: Record<CounselSeat, CounselSeatConfig>;
  /** Persona markdown per seat, passed to the CLI system-prompt flag. */
  systemPrompts: Record<CounselSeat, string>;
  style: CounselStyle;
  contextPass: boolean;
  maxTurns: number;
  minTurnsBeforeStop: number;
  moderatorEnabled: boolean;
  adjudicatorModel?: string;
}

export type CounselEvent =
  | { type: 'start'; counselId: string; prompt: string; seats: Record<CounselSeat, CounselSeatConfig> }
  | { type: 'context'; counselId: string; brief: string | null }
  | { type: 'turn-start'; counselId: string; turnId: string; seat: CounselSeat; round: number }
  | { type: 'turn-delta'; counselId: string; turnId: string; chunk: string }
  | { type: 'turn-end'; counselId: string; turnId: string; seat: CounselSeat; fullText: string }
  | { type: 'moderator'; counselId: string; decision: CounselModeratorDecision; note: string; round: number }
  | { type: 'phase'; counselId: string; phase: 'moderating' | 'adjudicating' }
  | { type: 'verdict'; counselId: string; verdict: CounselVerdict }
  | { type: 'done'; counselId: string; result: CounselResult }
  | { type: 'error'; counselId: string; message: string };

export interface CounselPreferences {
  maxTurns?: number;            // default 9
  style?: CounselStyle;         // default 'balanced'
  moderatorEnabled?: boolean;   // default true
  adjudicatorModel?: string;    // default: CLI default model
  contextPassDefault?: boolean; // default true
}

// --- Board ---

export type ColumnBehavior = 'inbox' | 'active' | 'terminal' | 'none';

export interface BoardColumn {
  id: string;
  title: string;
  order: number;
  behavior: ColumnBehavior;
  color?: string;
  locked?: boolean;
}

export interface BoardTask {
  id: string;
  title: string;
  prompt: string;
  notes?: string;
  columnId: string;
  order: number;
  sessionId?: string;
  cliSessionId?: string;
  providerId?: ProviderId;
  planMode?: boolean;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TagDefinition {
  name: string;
  color: string;
}

export interface BoardData {
  columns: BoardColumn[];
  tasks: BoardTask[];
  tags?: TagDefinition[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  sessions: SessionRecord[];
  activeSessionId: string | null;
  layout: {
    mode: 'tabs' | 'split' | 'swarm';
    splitPanes: string[];
    splitDirection: 'horizontal' | 'vertical';
  };
  board?: BoardData;
  sessionHistory?: ArchivedSession[];
  insights?: ProjectInsightsData;
  defaultArgs?: string;
  /** Last Codex account picked in New Session for this project; preselected next time. */
  defaultAccount?: string;
  wakeyDefaultDirection?: string;
  terminalPanelOpen?: boolean;
  terminalPanelHeight?: number;
  readiness?: ReadinessResult;
  readinessHistory?: ReadinessSnapshot[];
  overviewLayout?: OverviewLayout;
  githubLastSeen?: Record<string, string>;
  /** Completed counsel debates, most recent last. Capped at 20. */
  counsels?: CounselResult[];
  /** Last pre-pass checkbox choice for this project. Default true. */
  counselContextPass?: boolean;
  /** Date.now() of the last time any session in this project saw activity (creation or focus). Drives sidebar "recent" sort. */
  lastUsedAt?: number;
}

// --- Overview Widgets ---

export type OverviewWidgetType =
  | 'readiness'
  | 'provider-tools'
  | 'github-prs'
  | 'github-issues'
  | 'team'
  | 'kanban'
  | 'sleepy'
  | 'agent-graph';

export interface OverviewWidget {
  id: string;
  type: OverviewWidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
}

export interface OverviewLayout {
  gridVersion: 1;
  widgets: OverviewWidget[];
}

// --- GitHub ---

export interface GithubItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: { login: string; avatar_url: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present on issues that are PRs (Issues API includes PRs); absent on real issues. */
  pull_request?: { url: string };
  /** Optional PR-only fields populated when fetching from /pulls. */
  draft?: boolean;
  merged_at?: string | null;
  comments?: number;
  labels?: { name: string; color: string }[];
}

export interface GithubFetchResult {
  ok: boolean;
  items?: GithubItem[];
  error?: string;
}

export interface GithubRepo {
  owner: string;
  repo: string;
}

// --- Wakey (autonomous session supervisor) ---
// These live in shared/ because the run state crosses all three tsc projects:
// main owns it (src/main/wakey/run-store.ts re-exports these names), preload
// types the IPC surface with it, and the renderer mirrors it for the panel.
export type WakeyPhase = 'idle' | 'thinking' | 'typing' | 'stopped' | 'orphaned';
export type WakeyStopReason = 'goal-complete' | 'max-iterations' | 'errors' | 'user' | 'rate-cap';
export interface WakeyHistoryEntry { at: number; kind: 'steer' | 'fastpath' | 'error' | 'brain-restart'; text: string }
export interface WakeyRun {
  runId: string;              // stable identity (uuid); sessionId can be rebound on resume
  sessionId: string;
  cliSessionId: string | null;
  projectPath: string;
  projectId: string;
  direction: string | null;
  iterations: number;
  phase: WakeyPhase;
  lastSteer: string | null;
  history: WakeyHistoryEntry[];        // newest LAST, capped at 50
  transcriptOffset: number;            // byte offset into the session JSONL
  stop: { reason: WakeyStopReason; at: number } | null;
  supervisionTimestamps: number[];     // rolling window for the rate cap
  consecutiveErrors: number;
  startedAt: number;
  dismissed: boolean;
}
export interface WakeySnapshot { runs: WakeyRun[]; projectDefaults: Record<string, string> }

export interface Preferences {
  soundOnSessionWaiting: boolean;
  notificationsDesktop: boolean;
  debugMode: boolean;
  sessionHistoryEnabled: boolean;
  insightsEnabled: boolean;
  autoTitleEnabled: boolean;
  confirmCloseWorkingSession: boolean;
  zoomFactor?: number;
  defaultProvider?: ProviderId;
  statusLineConsent?: 'granted' | 'declined' | null;
  // The foreign statusLine command the user was asked about when they made
  // the consent decision. Used to detect new conflicts (different command)
  // vs the previously-acknowledged one.
  statusLineConsentCommand?: string | null;
  copyOnSelect?: boolean;
  keybindings?: Record<string, string>;
  theme?: 'dark' | 'light';
  globalDefaultArgs?: string;
  sleepyBin?: string;
  sleepyDashboardPort?: number;
  wakeyMaxIterations?: number;
  wakeySystemPrompt?: string;
  wakeyModel?: string;
  wakeyWatchdogMinutes?: number;
  counsel?: CounselPreferences;
  readinessExcludedProviders?: ProviderId[];
  sidebarViews?: {
    gitPanel: boolean;
    sessionHistory: boolean;
    costFooter: boolean;
    fileTree: boolean;
  };
  boardCardMetrics?: boolean;
  vaultPath?: string;
  /** Sidebar project-list order: 'recent' (default, most-recently-used first) or 'manual' (insertion/current order). */
  projectSortMode?: 'recent' | 'manual';
}

// --- Settings Validation ---

export interface SettingsValidationResult {
  statusLine: 'missing' | 'nightyard' | 'foreign';
  hooks: 'missing' | 'complete' | 'partial';
  foreignStatusLineCommand?: string;
  hookDetails: Record<string, boolean>;
}

export interface SettingsWarningData {
  sessionId: string;
  statusLine: SettingsValidationResult['statusLine'];
  hooks: SettingsValidationResult['hooks'];
}

export interface StatusLineConflictData {
  foreignCommand: string;
}

export interface PersistedState {
  version: 1;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  preferences: Preferences;
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  lastSeenVersion?: string;
  appLaunchCount?: number;
  starPromptDismissed?: boolean;
  team?: TeamData;
  globalOverview?: OverviewLayout; // NEW: app-scoped cross-project overview
  /** Session-host windows (Chrome-style detached tabs). Maintained by main; renderers never write it. */
  windows?: import('./window-types').SecondaryWindowRecord[];
}

// --- AI Readiness ---

export type ReadinessCheckStatus = 'pass' | 'fail' | 'warning';

export type ReadinessEffort = 'low' | 'medium' | 'high';

export interface ReadinessCheck {
  id: string;
  name: string;
  status: ReadinessCheckStatus;
  description: string;
  score: number;
  maxScore: number;
  fixPrompt?: string;
  providerIds?: ProviderId[];
  effort?: ReadinessEffort;
  impact?: number;
  rationale?: string;
}

export interface ReadinessCategory {
  id: string;
  name: string;
  weight: number;
  score: number;
  checks: ReadinessCheck[];
}

export interface ReadinessResult {
  overallScore: number;
  categories: ReadinessCategory[];
  scannedAt: string;
}

export interface ReadinessSnapshot {
  timestamp: string;
  overallScore: number;
  categoryScores: Record<string, number>;
}

// --- Cost / Context ---

export interface CostData {
  cost: { total_cost_usd: number; total_duration_ms: number; total_api_duration_ms: number };
  model?: string;
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
}

// --- Tool Failure ---

export interface ToolFailureData {
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
}

// --- Session Inspector ---

export type InspectorEventType =
  // Core 7 (status + inspector)
  | 'session_start' | 'user_prompt' | 'tool_use' | 'tool_failure'
  | 'stop' | 'stop_failure' | 'permission_request'
  // Inspector-only events
  | 'permission_denied'
  | 'pre_tool_use'
  | 'subagent_start' | 'subagent_stop'
  | 'notification'
  | 'pre_compact' | 'post_compact'
  | 'session_end'
  | 'task_created' | 'task_completed'
  | 'worktree_create' | 'worktree_remove'
  | 'cwd_changed' | 'file_changed' | 'config_change'
  | 'elicitation' | 'elicitation_result'
  | 'instructions_loaded'
  | 'teammate_idle'
  | 'status_update';

export interface InspectorEvent {
  type: InspectorEventType;
  timestamp: number;
  hookEvent: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  cost_snapshot?: { total_cost_usd: number; total_duration_ms: number };
  context_snapshot?: { total_tokens: number; context_window_size: number; used_percentage: number };
  agent_id?: string;
  agent_type?: string;
  last_assistant_message?: string;
  agent_transcript_path?: string;
  message?: string;
  task_id?: string;
  worktree_path?: string;
  cwd?: string;
  file_path?: string;
  config_key?: string;
  question?: string;
  answer?: string;
}

export interface ToolUsageStats {
  tool_name: string;
  calls: number;
  failures: number;
  totalCost: number;
}

export interface ContextDataPoint {
  timestamp: number;
  usedPercentage: number;
  totalTokens: number;
}

// --- MCP ---

export interface McpResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// --- Usage Stats ---

export interface StatsDailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface StatsModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: StatsDailyActivity[];
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[];
  modelUsage: Record<string, StatsModelUsage>;
  totalSessions: number;
  totalMessages: number;
  longestSession: { sessionId: string; duration: number; messageCount: number; timestamp: string };
  firstSessionDate: string;
  hourCounts: Record<string, number>;
}

// --- Filesystem IPC ---

export type ReadFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'binary' | 'error' };

// --- Vault / Knowledge Bank ---

export interface VaultNote {
  id: string;          // vault-relative path, e.g. "Notes/Roadmap.md"
  title: string;       // first H1 or filename without extension
  folder: string;      // top-level folder ('' for root)
  tags: string[];      // frontmatter tags + inline #tags, deduped
  wikilinks: string[]; // raw [[link]] targets (alias stripped)
  mtimeMs: number;
}

export interface VaultLink {
  source: string;
  target: string;
  type: 'wiki' | 'tag' | 'folder';
}

export interface VaultGraph {
  notes: VaultNote[];
  links: VaultLink[];
}
