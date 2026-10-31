import type {
  CounselEngine,
  CounselPreferences,
  CounselResult,
  CounselSeatConfig,
  CounselStartConfig,
  CounselStyle,
  ProjectRecord,
  TeamMember,
} from '../../../shared/types.js';
import { COUNSEL_SEATS } from '../../../shared/types.js';
import { appState } from '../../state.js';
import { suggestSeats } from '../../../shared/counsel-suggest.js';
import { getActiveCounsel, startCounsel } from '../../counsel-store.js';
import { createCustomSelect, type CustomSelectInstance } from '../custom-select.js';
import { renderDebate } from './debate-view.js';

const MIN_TURNS_BEFORE_STOP = 3;
const SUGGEST_DEBOUNCE_MS = 300;

const STYLE_OPTIONS: Array<{ value: CounselStyle; label: string }> = [
  { value: 'punchy', label: 'Punchy' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'thorough', label: 'Thorough' },
];

/** Seat toggle default: the member's preferred debate engine, else claude. */
export function defaultEngineForMember(member: TeamMember): CounselEngine {
  return member.counselEngine ?? 'claude';
}

/**
 * Same default, downgraded to claude when codex is known to be unavailable —
 * so a seat never defaults to an engine the toggle would show disabled.
 * `availability` is `null` before `checkEngines()` resolves, in which case
 * this is identical to `defaultEngineForMember` (corrected once it resolves).
 */
export function resolveEngineForMember(
  member: TeamMember,
  availability: { claude: boolean; codex: boolean } | null,
): CounselEngine {
  const preferred = defaultEngineForMember(member);
  return preferred === 'codex' && availability?.codex === false ? 'claude' : preferred;
}

/**
 * Pure mapping from a start-view pick set to the engine's start config.
 * Exported (and covered directly) so the seat-mapping/pref-defaulting logic
 * doesn't depend on any DOM or appState wiring to verify.
 */
export function buildStartConfig(args: {
  question: string;
  picks: Array<{ member: TeamMember; engine: CounselEngine }>;
  style: CounselStyle;
  contextPass: boolean;
  projectPath: string;
  prefs: CounselPreferences | undefined;
}): Omit<CounselStartConfig, 'counselId'> {
  const { question, picks, style, contextPass, projectPath, prefs } = args;

  const seats = {} as Record<(typeof COUNSEL_SEATS)[number], CounselSeatConfig>;
  const systemPrompts = {} as Record<(typeof COUNSEL_SEATS)[number], string>;

  COUNSEL_SEATS.forEach((seat, index) => {
    const pick = picks[index];
    seats[seat] = {
      memberId: pick.member.id,
      memberName: pick.member.name,
      memberRole: pick.member.role,
      providerId: pick.engine,
      ...(pick.member.counselModel ? { model: pick.member.counselModel } : {}),
    };
    systemPrompts[seat] = pick.member.systemPrompt;
  });

  return {
    projectPath,
    prompt: question,
    seats,
    systemPrompts,
    style,
    contextPass,
    maxTurns: prefs?.maxTurns ?? 9,
    minTurnsBeforeStop: MIN_TURNS_BEFORE_STOP,
    moderatorEnabled: prefs?.moderatorEnabled ?? true,
    adjudicatorModel: prefs?.adjudicatorModel,
  };
}

// --- View ---

export interface SeatPick {
  memberId: string | null;
  engine: CounselEngine;
  /** Once true, re-suggestion from typing no longer overwrites this seat's member. */
  touched: boolean;
}

/**
 * Pure reconciliation: refills untouched seats from suggestSeats(question),
 * leaving touched seats exactly as they are. Members already held by a
 * touched seat are excluded from the suggestion pool *before* ranking, so an
 * untouched seat can never be assigned a member another seat already holds
 * (suggestSeats always ranks the full member list — without this exclusion,
 * a highly-relevant member held by a touched seat could still be ranked #1
 * and handed to an untouched seat too, duplicating it).
 * Exported (and covered directly) so this dedupe logic doesn't depend on any
 * DOM wiring to verify.
 */
export function reconcileSeatSuggestions(
  question: string,
  members: TeamMember[],
  seats: readonly SeatPick[],
  engineAvailability: { claude: boolean; codex: boolean } | null,
): SeatPick[] {
  const touchedIds = new Set(
    seats.filter((s) => s.touched && s.memberId).map((s) => s.memberId as string),
  );
  const eligibleMembers = members.filter((m) => !touchedIds.has(m.id));
  const suggested = suggestSeats(question, eligibleMembers);

  let suggestIndex = 0;
  return seats.map((seat) => {
    if (seat.touched) return seat;
    const member = suggested[suggestIndex];
    if (!member) return seat; // not enough eligible members to fill this seat yet — leave as-is
    suggestIndex++;
    return { memberId: member.id, engine: resolveEngineForMember(member, engineAvailability), touched: false };
  });
}

interface StartViewState {
  question: string;
  seats: [SeatPick, SeatPick, SeatPick];
  style: CounselStyle;
  contextPass: boolean;
  engineAvailability: { claude: boolean; codex: boolean } | null;
}

interface StartViewMount {
  container: HTMLElement;
  refresh: () => void;
  destroySelects: () => void;
}

const mounts = new WeakMap<HTMLElement, StartViewMount>();

function emptySeatPick(): SeatPick {
  return { memberId: null, engine: 'claude', touched: false };
}

function createInitialState(project: ProjectRecord | undefined, prefs: CounselPreferences | undefined): StartViewState {
  // Seats start untouched and unassigned; the initial refresh() below runs
  // applySuggestions() against the current member list to fill them in. This
  // also covers the case where the team is empty at mount time (0 members)
  // and only gets populated later (members added from the Team tab) —
  // reconciliation happens on every refresh(), not just at mount.
  return {
    question: '',
    seats: [emptySeatPick(), emptySeatPick(), emptySeatPick()],
    style: prefs?.style ?? 'balanced',
    contextPass: project?.counselContextPass ?? prefs?.contextPassDefault ?? true,
    engineAvailability: null,
  };
}

/** Tears down this root's tracked custom-select instances (their outside-click listeners survive `remove()` otherwise). Safe to call even if nothing is mounted. Exported for counsel-view.ts to call before handing the root to the debate view. */
/** A counsel seats exactly three debaters; the start form is gated behind that. */
export const COUNSEL_MIN_MEMBERS = 3;

/** Empty-team nudge copy: says how many members are still missing. Empty once the form can show. */
export function emptyTeamMessage(memberCount: number): string {
  const missing = COUNSEL_MIN_MEMBERS - memberCount;
  if (missing <= 0) return '';
  return `Your counsel needs ${COUNSEL_MIN_MEMBERS} members — you have ${memberCount}. ` +
    `Add ${missing} more from the Team tab.`;
}

export function resetStartView(root: HTMLElement): void {
  const mount = mounts.get(root);
  if (!mount) return;
  mount.destroySelects();
  mounts.delete(root);
}

export function renderStartView(root: HTMLElement, projectId: string): void {
  const existing = mounts.get(root);
  if (existing && root.contains(existing.container)) {
    existing.refresh();
    return;
  }
  mounts.delete(root);
  root.innerHTML = '';
  mountStartView(root, projectId);
}

function mountStartView(root: HTMLElement, projectId: string): void {
  const project = appState.projects.find((p) => p.id === projectId);
  const prefsSnapshot = appState.preferences.counsel;
  const state = createInitialState(project, prefsSnapshot);

  const container = document.createElement('div');
  container.className = 'counsel-start';

  const formSection = document.createElement('div');
  formSection.className = 'counsel-start-form';

  const emptyTeamSection = document.createElement('div');
  emptyTeamSection.className = 'counsel-empty-team';

  const historyContainer = document.createElement('div');
  historyContainer.className = 'counsel-history';

  container.appendChild(emptyTeamSection);
  container.appendChild(formSection);
  container.appendChild(historyContainer);
  root.appendChild(container);

  // -- Question textarea (built once — never recreated, so typing keeps focus/cursor) --
  const questionLabel = document.createElement('label');
  questionLabel.className = 'counsel-question-label';
  questionLabel.textContent = 'What should the counsel debate?';

  const questionInput = document.createElement('textarea');
  questionInput.className = 'counsel-question';
  questionInput.placeholder = 'Describe the question or decision you want debated…';
  questionInput.value = state.question;

  formSection.appendChild(questionLabel);
  formSection.appendChild(questionInput);

  const seatRow = document.createElement('div');
  seatRow.className = 'counsel-seat-row';
  formSection.appendChild(seatRow);

  const optionsRow = document.createElement('div');
  optionsRow.className = 'counsel-start-options';
  formSection.appendChild(optionsRow);

  const startBtn = document.createElement('button');
  startBtn.className = 'counsel-start-btn';
  startBtn.textContent = 'Start counsel';
  formSection.appendChild(startBtn);

  let activeSeatSelects: CustomSelectInstance[] = [];
  let styleSelect: CustomSelectInstance | null = null;

  function currentMembers(): TeamMember[] {
    return appState.getTeamMembers();
  }

  function renderSeatRow(): void {
    activeSeatSelects.forEach((s) => s.destroy());
    activeSeatSelects = [];
    seatRow.innerHTML = '';

    const members = currentMembers();
    state.seats.forEach((pick, seatIndex) => {
      const card = document.createElement('div');
      card.className = `counsel-seat-card counsel-seat-${COUNSEL_SEATS[seatIndex].toLowerCase()}`;

      const label = document.createElement('div');
      label.className = 'counsel-seat-card-label';
      label.textContent = `Seat ${COUNSEL_SEATS[seatIndex]}`;
      card.appendChild(label);

      const otherPicks = new Set(
        state.seats.filter((_, i) => i !== seatIndex).map((s) => s.memberId).filter((id): id is string => !!id),
      );
      const memberOptions = members.map((m) => ({
        value: m.id,
        label: m.name,
        disabled: otherPicks.has(m.id),
      }));

      const memberSelect = createCustomSelect(
        `counsel-seat-${seatIndex}-member`,
        memberOptions,
        pick.memberId ?? undefined,
        (value) => {
          const member = members.find((m) => m.id === value);
          pick.memberId = value;
          pick.touched = true;
          if (member) pick.engine = resolveEngineForMember(member, state.engineAvailability);
          renderSeatRow();
        },
      );
      activeSeatSelects.push(memberSelect);
      card.appendChild(memberSelect.element);

      const codexAvailable = state.engineAvailability?.codex !== false;
      const engineSelect = createCustomSelect(
        `counsel-seat-${seatIndex}-engine`,
        [
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex', disabled: !codexAvailable },
        ],
        pick.engine,
        (value) => {
          pick.engine = value as CounselEngine;
        },
      );
      if (!codexAvailable) {
        engineSelect.element.title = 'codex CLI not found';
      }
      activeSeatSelects.push(engineSelect);
      card.appendChild(engineSelect.element);

      seatRow.appendChild(card);
    });

    refreshStartButton();
  }

  function applySuggestions(): void {
    const members = currentMembers();
    state.seats = reconcileSeatSuggestions(state.question, members, state.seats, state.engineAvailability) as [
      SeatPick,
      SeatPick,
      SeatPick,
    ];
    renderSeatRow();
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  questionInput.addEventListener('input', () => {
    state.question = questionInput.value;
    refreshStartButton();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applySuggestions, SUGGEST_DEBOUNCE_MS);
  });

  // -- Style + pre-pass row (built once; option set never changes) --
  const styleField = document.createElement('div');
  styleField.className = 'counsel-start-field';
  const styleLabel = document.createElement('label');
  styleLabel.textContent = 'Style';
  styleField.appendChild(styleLabel);
  styleSelect = createCustomSelect(
    'counsel-style',
    STYLE_OPTIONS,
    state.style,
    (value) => {
      state.style = value as CounselStyle;
    },
  );
  styleField.appendChild(styleSelect.element);
  optionsRow.appendChild(styleField);

  const contextPassField = document.createElement('div');
  contextPassField.className = 'counsel-start-field counsel-start-field-checkbox';
  const contextPassCheckbox = document.createElement('input');
  contextPassCheckbox.type = 'checkbox';
  contextPassCheckbox.id = 'counsel-context-pass';
  contextPassCheckbox.checked = state.contextPass;
  contextPassCheckbox.addEventListener('change', () => {
    state.contextPass = contextPassCheckbox.checked;
  });
  const contextPassLabel = document.createElement('label');
  contextPassLabel.setAttribute('for', 'counsel-context-pass');
  contextPassLabel.textContent = 'Give the counsel a project context pre-pass';
  contextPassField.appendChild(contextPassCheckbox);
  contextPassField.appendChild(contextPassLabel);
  optionsRow.appendChild(contextPassField);

  let startInFlight = false;

  function refreshStartButton(): void {
    const active = getActiveCounsel();
    const blockedByActive = !!active && active.status !== 'done';
    const questionEmpty = state.question.trim().length === 0;
    const notEnoughMembers = currentMembers().length < 3;
    startBtn.disabled = startInFlight || blockedByActive || questionEmpty || notEnoughMembers;
    startBtn.title = startInFlight
      ? 'Starting…'
      : blockedByActive
        ? 'A counsel debate is already in progress'
        : questionEmpty
          ? 'Enter a question first'
          : notEnoughMembers
            ? 'Add at least 3 team members'
            : '';
  }

  async function handleStart(): Promise<void> {
    // Guards the click itself (belt) in addition to the synchronous disable
    // below (suspenders) — a fast double-click must never spawn a second
    // debate on top of one already in flight, which would orphan the first
    // (counsel-store only tracks a single active counsel).
    if (startInFlight) return;
    const active = getActiveCounsel();
    if (active && active.status !== 'done') return;
    const members = currentMembers();
    if (state.question.trim().length === 0 || members.length < 3) return;

    const picks: Array<{ member: TeamMember; engine: CounselEngine } | null> = state.seats.map((pick) => {
      const member = members.find((m) => m.id === pick.memberId);
      return member ? { member, engine: pick.engine } : null;
    });
    if (picks.some((p) => p === null)) return;

    const config = buildStartConfig({
      question: state.question.trim(),
      picks: picks as Array<{ member: TeamMember; engine: CounselEngine }>,
      style: state.style,
      contextPass: state.contextPass,
      projectPath: project?.path ?? '',
      prefs: appState.preferences.counsel,
    });

    // Set synchronously, before the first await, so no event loop turn can
    // slip a second click through between the guard check above and the
    // button actually reflecting the in-flight state.
    startInFlight = true;
    refreshStartButton();

    try {
      if (project) {
        project.counselContextPass = state.contextPass;
        appState.notifyCounselChanged();
      }
      await startCounsel(projectId, config);
      // On success the router's onCounselChange subscription tears this view
      // down in favor of the debate view — no need to re-enable startBtn.
    } catch (err) {
      startInFlight = false;
      refreshStartButton();
      console.error('[counsel] startCounsel failed', err);
    }
  }

  startBtn.addEventListener('click', () => {
    void handleStart();
  });

  // -- Empty-team state --
  function renderEmptyTeamState(): void {
    emptyTeamSection.innerHTML = '';
    const members = currentMembers();
    const isEmpty = members.length < COUNSEL_MIN_MEMBERS;
    emptyTeamSection.classList.toggle('hidden', !isEmpty);
    formSection.classList.toggle('hidden', isEmpty);
    if (!isEmpty) return;

    const msg = document.createElement('p');
    msg.className = 'counsel-empty-team-message';
    msg.textContent = emptyTeamMessage(members.length);
    emptyTeamSection.appendChild(msg);

    const teamBtn = document.createElement('button');
    teamBtn.className = 'counsel-btn counsel-btn-primary';
    teamBtn.textContent = 'Go to Team';
    teamBtn.addEventListener('click', () => appState.openTeamTab(projectId));
    emptyTeamSection.appendChild(teamBtn);
  }

  // -- History --
  function renderHistory(): void {
    historyContainer.innerHTML = '';
    const counsels = project?.counsels ?? [];
    if (counsels.length === 0) return;

    const heading = document.createElement('div');
    heading.className = 'counsel-history-heading';
    heading.textContent = 'History';
    historyContainer.appendChild(heading);

    for (let i = counsels.length - 1; i >= 0; i--) {
      historyContainer.appendChild(buildHistoryItem(counsels[i]));
    }
  }

  function buildHistoryItem(result: CounselResult): HTMLElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'counsel-history-item';

    const question = document.createElement('span');
    question.className = 'counsel-history-question';
    question.textContent = result.prompt;
    item.appendChild(question);

    const date = document.createElement('span');
    date.className = 'counsel-history-date';
    date.textContent = new Date(result.startedAt).toLocaleString();
    item.appendChild(date);

    if (result.verdict) {
      const badge = document.createElement('span');
      badge.className = `counsel-confidence-badge counsel-confidence-${result.verdict.confidence}`;
      badge.textContent = result.verdict.confidence;
      item.appendChild(badge);
    }

    item.addEventListener('click', () => {
      resetStartView(root);
      root.innerHTML = '';
      // CounselResult carries no projectId, so debate-view can't route back
      // to the start view on its own for a history entry — hand it this
      // closure, which is the only place that still has projectId in scope.
      renderDebate(root, result, () => renderStartView(root, projectId));
    });

    return item;
  }

  function refresh(): void {
    renderEmptyTeamState();
    // Reconciles + rebuilds the seat row (not a plain renderSeatRow() call):
    // this fills in seats that are still unassigned or whose suggestions are
    // now stale against the current member list — notably right after the
    // first members are added, when the seats were seeded empty at mount.
    applySuggestions();
    renderHistory();
    refreshStartButton();
  }

  const mount: StartViewMount = {
    container,
    refresh,
    destroySelects: () => {
      activeSeatSelects.forEach((s) => s.destroy());
      styleSelect?.destroy();
    },
  };
  mounts.set(root, mount);

  refresh();

  // Engine availability is checked once per mount; repaint the seat row when it resolves
  // so a missing codex binary shows up as disabled with its tooltip. Guard on mount
  // identity (not just presence) — the root may have been torn down and remounted
  // fresh (e.g. router round-tripped through the debate view) before this resolves,
  // and we must not repaint the stale, now-detached seat row from this closure.
  void window.nightyard.counsel.checkEngines().then((availability) => {
    if (mounts.get(root) !== mount) return;
    state.engineAvailability = availability;
    // Seats can only be sitting on 'codex' right now because they were
    // defaulted before availability was known (the toggle disables the
    // codex option below, so a user could never have picked it manually
    // while it's unavailable) — downgrade those to claude rather than
    // leave them showing codex selected-but-disabled.
    if (availability.codex === false) {
      state.seats.forEach((pick) => {
        if (pick.engine === 'codex') pick.engine = 'claude';
      });
    }
    renderSeatRow();
  });
}
