import { appState } from '../state.js';
import { createCustomSelect, type CustomSelectInstance } from './custom-select.js';
import { applyZoom, getZoomFactor, ZOOM_STEPS } from '../zoom.js';
import { shortcutManager, displayKeys, eventToAccelerator } from '../shortcuts.js';
import { loadProviderAvailability, getProviderAvailabilitySnapshot } from '../provider-availability.js';
import type { CliProviderMeta, CounselStyle, ProviderId, SettingsValidationResult } from '../../shared/types.js';
import { hasProviderIssue, type ProviderStatus } from './setup-checks.js';
import { createModalShell, createModalButton } from './modal-shell.js';

let cleanupFn: (() => void) | null = null;

type Section = 'general' | 'appearance' | 'shortcuts' | 'setup' | 'about';

export function showPreferencesModal(): void {
  cleanupFn?.();
  cleanupFn = null;

  const { overlay, body: bodyEl, actions } = createModalShell({
    id: 'preferences-overlay',
    title: 'Preferences',
    wide: true,
  });
  bodyEl.innerHTML = '';
  actions.innerHTML = '';

  const btnCancel = createModalButton('Cancel', false);
  btnCancel.id = 'preferences-cancel';
  actions.appendChild(btnCancel);
  const btnConfirm = createModalButton('Done', true);
  btnConfirm.id = 'preferences-confirm';
  actions.appendChild(btnConfirm);

  // Build two-pane layout
  const layout = document.createElement('div');
  layout.className = 'preferences-layout';

  // Side menu
  const menu = document.createElement('div');
  menu.className = 'preferences-menu';

  const sections: { id: Section; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'setup', label: 'Setup' },
    { id: 'about', label: 'About' },
  ];

  const menuItems: Map<Section, HTMLDivElement> = new Map();
  for (const section of sections) {
    const item = document.createElement('div');
    item.className = 'preferences-menu-item';
    item.textContent = section.label;
    item.dataset.section = section.id;
    menu.appendChild(item);
    menuItems.set(section.id, item);
  }

  // Content area
  const content = document.createElement('div');
  content.className = 'preferences-content';

  layout.appendChild(menu);
  layout.appendChild(content);
  bodyEl.appendChild(layout);

  // Build section content
  let currentSection: Section = 'general';
  let soundCheckbox: HTMLInputElement | null = null;
  let notificationsCheckbox: HTMLInputElement | null = null;
  let historyCheckbox: HTMLInputElement | null = null;
  let insightsCheckbox: HTMLInputElement | null = null;
  let autoTitleCheckbox: HTMLInputElement | null = null;
  let confirmCloseCheckbox: HTMLInputElement | null = null;
  let copyOnSelectCheckbox: HTMLInputElement | null = null;
  let defaultProviderSelect: CustomSelectInstance | null = null;
  let themeSelect: CustomSelectInstance | null = null;
  let zoomSelect: CustomSelectInstance | null = null;
  let zoomPrefUnsub: (() => void) | null = null;
  let debugModeCheckbox: HTMLInputElement | null = null;
  let globalDefaultArgsInput: HTMLInputElement | null = null;
  let sleepyBinInput: HTMLInputElement | null = null;
  let sleepyDashboardPortInput: HTMLInputElement | null = null;
  let wakeyMaxIterationsInput: HTMLInputElement | null = null;
  let wakeySystemPromptInput: HTMLTextAreaElement | null = null;
  let wakeyWatchdogMinutesInput: HTMLInputElement | null = null;
  let wakeyModelInput: HTMLInputElement | null = null;
  let vaultPathInput: HTMLInputElement | null = null;
  let sidebarCheckboxes: { gitPanel: HTMLInputElement; sessionHistory: HTMLInputElement; costFooter: HTMLInputElement; fileTree: HTMLInputElement } | null = null;
  let boardCardMetricsCheckbox: HTMLInputElement | null = null;
  let counselMaxTurnsInput: HTMLInputElement | null = null;
  let counselStyleSelect: CustomSelectInstance | null = null;
  let counselModeratorCheckbox: HTMLInputElement | null = null;
  let counselAdjudicatorModelInput: HTMLInputElement | null = null;
  let counselContextPassCheckbox: HTMLInputElement | null = null;
  let activeRecorder: { cleanup: () => void } | null = null;
  const originalTheme = appState.preferences.theme ?? 'dark';

  function cleanupRecorder() {
    if (activeRecorder) {
      activeRecorder.cleanup();
      activeRecorder = null;
    }
  }

  function renderSection(section: Section) {
    cleanupRecorder();
    zoomPrefUnsub?.();
    zoomPrefUnsub = null;
    currentSection = section;
    content.innerHTML = '';

    // Update active menu item
    for (const [id, item] of menuItems) {
      item.classList.toggle('active', id === section);
    }

    if (section === 'general') {
      // Default provider dropdown
      const providerRow = document.createElement('div');
      providerRow.className = 'modal-toggle-field';

      const providerLabel = document.createElement('label');
      providerLabel.textContent = 'Default coding tool';

      const currentDefault = appState.preferences.defaultProvider ?? 'claude';

      const buildProviderOptions = (providers: CliProviderMeta[]) =>
        providers.map(p => ({ value: p.id, label: p.displayName }));

      let snapshot = getProviderAvailabilitySnapshot();
      if (snapshot) {
        defaultProviderSelect = createCustomSelect('pref-default-provider', buildProviderOptions(snapshot.providers), currentDefault);
      } else {
        defaultProviderSelect = createCustomSelect('pref-default-provider', [{ value: currentDefault, label: 'Loading…' }], currentDefault);
        loadProviderAvailability().then(() => {
          if (currentSection !== 'general') return;
          snapshot = getProviderAvailabilitySnapshot();
          if (snapshot) {
            if (defaultProviderSelect) defaultProviderSelect.destroy();
            defaultProviderSelect = createCustomSelect('pref-default-provider', buildProviderOptions(snapshot.providers), currentDefault);
            providerRow.querySelector('.custom-select')?.remove();
            providerRow.appendChild(defaultProviderSelect.element);
          }
        });
      }

      providerRow.appendChild(providerLabel);
      providerRow.appendChild(defaultProviderSelect.element);
      content.appendChild(providerRow);

      const row = document.createElement('div');
      row.className = 'modal-toggle-field';

      const label = document.createElement('label');
      label.htmlFor = 'pref-sound-on-waiting';
      label.textContent = 'Play sound when session finishes work';

      soundCheckbox = document.createElement('input');
      soundCheckbox.type = 'checkbox';
      soundCheckbox.id = 'pref-sound-on-waiting';
      soundCheckbox.checked = appState.preferences.soundOnSessionWaiting;

      row.appendChild(label);
      row.appendChild(soundCheckbox);
      content.appendChild(row);

      const notifRow = document.createElement('div');
      notifRow.className = 'modal-toggle-field';

      const notifLabel = document.createElement('label');
      notifLabel.htmlFor = 'pref-notifications-desktop';
      notifLabel.textContent = 'Desktop notifications when sessions need attention';

      notificationsCheckbox = document.createElement('input');
      notificationsCheckbox.type = 'checkbox';
      notificationsCheckbox.id = 'pref-notifications-desktop';
      notificationsCheckbox.checked = appState.preferences.notificationsDesktop;

      notifRow.appendChild(notifLabel);
      notifRow.appendChild(notificationsCheckbox);
      content.appendChild(notifRow);

      const historyRow = document.createElement('div');
      historyRow.className = 'modal-toggle-field';

      const historyLabel = document.createElement('label');
      historyLabel.htmlFor = 'pref-session-history';
      historyLabel.textContent = 'Record session history when sessions close';

      historyCheckbox = document.createElement('input');
      historyCheckbox.type = 'checkbox';
      historyCheckbox.id = 'pref-session-history';
      historyCheckbox.checked = appState.preferences.sessionHistoryEnabled;

      historyRow.appendChild(historyLabel);
      historyRow.appendChild(historyCheckbox);
      content.appendChild(historyRow);

      const insightsRow = document.createElement('div');
      insightsRow.className = 'modal-toggle-field';

      const insightsLabel = document.createElement('label');
      insightsLabel.htmlFor = 'pref-insights-enabled';
      insightsLabel.textContent = 'Show insight alerts';

      insightsCheckbox = document.createElement('input');
      insightsCheckbox.type = 'checkbox';
      insightsCheckbox.id = 'pref-insights-enabled';
      insightsCheckbox.checked = appState.preferences.insightsEnabled;

      insightsRow.appendChild(insightsLabel);
      insightsRow.appendChild(insightsCheckbox);
      content.appendChild(insightsRow);

      const autoTitleRow = document.createElement('div');
      autoTitleRow.className = 'modal-toggle-field';

      const autoTitleLabel = document.createElement('label');
      autoTitleLabel.htmlFor = 'pref-auto-title';
      autoTitleLabel.textContent = 'Auto-name sessions from conversation title';

      autoTitleCheckbox = document.createElement('input');
      autoTitleCheckbox.type = 'checkbox';
      autoTitleCheckbox.id = 'pref-auto-title';
      autoTitleCheckbox.checked = appState.preferences.autoTitleEnabled;

      autoTitleRow.appendChild(autoTitleLabel);
      autoTitleRow.appendChild(autoTitleCheckbox);
      content.appendChild(autoTitleRow);

      const confirmCloseRow = document.createElement('div');
      confirmCloseRow.className = 'modal-toggle-field';

      const confirmCloseLabel = document.createElement('label');
      confirmCloseLabel.htmlFor = 'pref-confirm-close-working';
      confirmCloseLabel.textContent = 'Confirm closing an active session';

      confirmCloseCheckbox = document.createElement('input');
      confirmCloseCheckbox.type = 'checkbox';
      confirmCloseCheckbox.id = 'pref-confirm-close-working';
      confirmCloseCheckbox.checked = appState.preferences.confirmCloseWorkingSession;

      confirmCloseRow.appendChild(confirmCloseLabel);
      confirmCloseRow.appendChild(confirmCloseCheckbox);
      content.appendChild(confirmCloseRow);

      const copyOnSelectRow = document.createElement('div');
      copyOnSelectRow.className = 'modal-toggle-field';

      const copyOnSelectLabel = document.createElement('label');
      copyOnSelectLabel.htmlFor = 'pref-copy-on-select';
      copyOnSelectLabel.textContent = 'Copy on select';

      copyOnSelectCheckbox = document.createElement('input');
      copyOnSelectCheckbox.type = 'checkbox';
      copyOnSelectCheckbox.id = 'pref-copy-on-select';
      copyOnSelectCheckbox.checked = appState.preferences.copyOnSelect ?? false;

      copyOnSelectRow.appendChild(copyOnSelectLabel);
      copyOnSelectRow.appendChild(copyOnSelectCheckbox);
      content.appendChild(copyOnSelectRow);

    } else if (section === 'appearance') {
      const themeRow = document.createElement('div');
      themeRow.className = 'modal-toggle-field';

      const themeLabel = document.createElement('label');
      themeLabel.textContent = 'Theme';

      themeSelect = createCustomSelect(
        'pref-theme',
        [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
        originalTheme,
        (value) => { document.documentElement.dataset.theme = value; },
      );

      themeRow.appendChild(themeLabel);
      themeRow.appendChild(themeSelect.element);
      content.appendChild(themeRow);

      const zoomRow = document.createElement('div');
      zoomRow.className = 'modal-toggle-field';

      const zoomLabel = document.createElement('label');
      zoomLabel.textContent = 'Zoom';

      const zoomOptions = ZOOM_STEPS.map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%` }));
      zoomSelect = createCustomSelect('pref-zoom', zoomOptions, String(getZoomFactor()), (value) => {
        const n = parseFloat(value);
        if (!Number.isNaN(n)) applyZoom(n);
      });

      zoomRow.appendChild(zoomLabel);
      zoomRow.appendChild(zoomSelect.element);
      content.appendChild(zoomRow);

      zoomPrefUnsub?.();
      zoomPrefUnsub = appState.on('preferences-changed', () => {
        zoomSelect?.setValue(String(getZoomFactor()));
      });

      const cliDefaultsHeading = document.createElement('div');
      cliDefaultsHeading.className = 'preferences-subheading';
      cliDefaultsHeading.textContent = 'CLI Defaults';
      content.appendChild(cliDefaultsHeading);

      const argsRow = document.createElement('div');
      argsRow.className = 'modal-toggle-field';
      const argsLabel = document.createElement('label');
      argsLabel.textContent = 'Global Args (every session)';
      argsLabel.htmlFor = 'pref-global-default-args';
      argsRow.appendChild(argsLabel);
      const argsInput = document.createElement('input');
      argsInput.type = 'text';
      argsInput.id = 'pref-global-default-args';
      argsInput.value = appState.preferences.globalDefaultArgs ?? '';
      argsInput.placeholder = '--dangerously-skip-permissions';
      argsInput.style.flex = '1';
      argsRow.appendChild(argsInput);
      content.appendChild(argsRow);
      globalDefaultArgsInput = argsInput;

      // SLEEPY section
      const sleepyHeading = document.createElement('div');
      sleepyHeading.className = 'preferences-subheading';
      sleepyHeading.textContent = 'SLEEPY';
      content.appendChild(sleepyHeading);

      const binRow = document.createElement('div');
      binRow.className = 'preferences-row';
      const binLabel = document.createElement('label');
      binLabel.textContent = 'Own Sleepy CLI (optional)';
      binLabel.htmlFor = 'pref-sleepy-bin';
      binRow.appendChild(binLabel);
      const binInput = document.createElement('input');
      binInput.type = 'text';
      binInput.id = 'pref-sleepy-bin';
      binInput.value = appState.preferences.sleepyBin ?? '';
      binInput.placeholder = 'Built in — or /path/to/sleepy/cli/bin/sleepy.mjs';
      binInput.style.flex = '1';
      binRow.appendChild(binInput);
      content.appendChild(binRow);
      sleepyBinInput = binInput;

      const portRow = document.createElement('div');
      portRow.className = 'preferences-row';
      const portLabel = document.createElement('label');
      portLabel.textContent = 'Dashboard port';
      portLabel.htmlFor = 'pref-sleepy-dashboard-port';
      portRow.appendChild(portLabel);
      const portInput = document.createElement('input');
      portInput.type = 'number';
      portInput.id = 'pref-sleepy-dashboard-port';
      portInput.min = '1024';
      portInput.max = '65535';
      portInput.value = String(appState.preferences.sleepyDashboardPort ?? 8910);
      portInput.style.width = '100px';
      portRow.appendChild(portInput);
      content.appendChild(portRow);
      sleepyDashboardPortInput = portInput;

      const wakeyHeading = document.createElement('div');
      wakeyHeading.className = 'preferences-subheading';
      wakeyHeading.textContent = 'Wakey';
      content.appendChild(wakeyHeading);

      const maxRow = document.createElement('div');
      maxRow.className = 'preferences-row';
      const maxLabel = document.createElement('label');
      maxLabel.textContent = 'Max iterations';
      maxLabel.htmlFor = 'pref-wakey-max-iterations';
      maxRow.appendChild(maxLabel);
      const maxInput = document.createElement('input');
      maxInput.type = 'number';
      maxInput.id = 'pref-wakey-max-iterations';
      maxInput.min = '1';
      maxInput.max = '500';
      maxInput.value = String(appState.preferences.wakeyMaxIterations ?? 50);
      maxInput.style.width = '100px';
      maxRow.appendChild(maxInput);
      content.appendChild(maxRow);
      wakeyMaxIterationsInput = maxInput;

      const watchdogRow = document.createElement('div');
      watchdogRow.className = 'preferences-row';
      const watchdogLabel = document.createElement('label');
      watchdogLabel.textContent = 'Watchdog quiet minutes';
      watchdogLabel.htmlFor = 'pref-wakey-watchdog-minutes';
      watchdogRow.appendChild(watchdogLabel);
      const watchdogInput = document.createElement('input');
      watchdogInput.type = 'number';
      watchdogInput.id = 'pref-wakey-watchdog-minutes';
      watchdogInput.min = '1';
      watchdogInput.placeholder = '3';
      watchdogInput.value = String(appState.preferences.wakeyWatchdogMinutes ?? 3);
      watchdogInput.style.width = '100px';
      watchdogRow.appendChild(watchdogInput);
      content.appendChild(watchdogRow);
      wakeyWatchdogMinutesInput = watchdogInput;

      const wakeyModelRow = document.createElement('div');
      wakeyModelRow.className = 'preferences-row';
      const wakeyModelLabel = document.createElement('label');
      wakeyModelLabel.textContent = 'Supervisor model';
      wakeyModelLabel.htmlFor = 'pref-wakey-model';
      wakeyModelRow.appendChild(wakeyModelLabel);
      const wakeyModelInputEl = document.createElement('input');
      wakeyModelInputEl.type = 'text';
      wakeyModelInputEl.id = 'pref-wakey-model';
      wakeyModelInputEl.placeholder = 'sonnet';
      wakeyModelInputEl.value = appState.preferences.wakeyModel ?? '';
      wakeyModelInputEl.style.width = '160px';
      wakeyModelRow.appendChild(wakeyModelInputEl);
      content.appendChild(wakeyModelRow);
      wakeyModelInput = wakeyModelInputEl;

      const wakeyPromptRow = document.createElement('div');
      wakeyPromptRow.className = 'preferences-row';
      const wakeyPromptLabel = document.createElement('label');
      wakeyPromptLabel.textContent = 'System prompt (override)';
      wakeyPromptLabel.htmlFor = 'pref-wakey-system-prompt';
      wakeyPromptRow.appendChild(wakeyPromptLabel);
      const wakeyPromptArea = document.createElement('textarea');
      wakeyPromptArea.id = 'pref-wakey-system-prompt';
      wakeyPromptArea.value = appState.preferences.wakeySystemPrompt ?? '';
      wakeyPromptArea.placeholder = 'Leave empty for default';
      wakeyPromptArea.style.flex = '1';
      wakeyPromptArea.style.minHeight = '60px';
      wakeyPromptRow.appendChild(wakeyPromptArea);
      content.appendChild(wakeyPromptRow);
      wakeySystemPromptInput = wakeyPromptArea;

      const knowledgeHeading = document.createElement('div');
      knowledgeHeading.className = 'preferences-subheading';
      knowledgeHeading.textContent = 'Knowledge Bank';
      content.appendChild(knowledgeHeading);

      const vaultPathRow = document.createElement('div');
      vaultPathRow.className = 'preferences-row';
      const vaultPathLabel = document.createElement('label');
      vaultPathLabel.textContent = 'Knowledge vault path';
      vaultPathLabel.htmlFor = 'pref-vault-path';
      vaultPathRow.appendChild(vaultPathLabel);
      const vaultPathInputEl = document.createElement('input');
      vaultPathInputEl.type = 'text';
      vaultPathInputEl.id = 'pref-vault-path';
      vaultPathInputEl.value = appState.preferences.vaultPath ?? '';
      vaultPathInputEl.placeholder = '~/ObsidianVault (default) — any Obsidian vault folder';
      vaultPathInputEl.style.flex = '1';
      vaultPathRow.appendChild(vaultPathInputEl);
      content.appendChild(vaultPathRow);
      vaultPathInput = vaultPathInputEl;

      const sidebarViewsHeading = document.createElement('div');
      sidebarViewsHeading.className = 'preferences-subheading';
      sidebarViewsHeading.textContent = 'Sidebar Views';
      content.appendChild(sidebarViewsHeading);

      const views = appState.preferences.sidebarViews ?? { gitPanel: true, sessionHistory: true, costFooter: true, fileTree: true };
      const toggles: { key: keyof typeof views; label: string }[] = [
        { key: 'fileTree', label: 'Project File Tree' },
        { key: 'gitPanel', label: 'Git Panel' },
        { key: 'sessionHistory', label: 'Session History' },
        { key: 'costFooter', label: 'Cost Footer' },
      ];

      const checkboxes: Record<string, HTMLInputElement> = {};
      for (const toggle of toggles) {
        const row = document.createElement('div');
        row.className = 'modal-toggle-field';

        const label = document.createElement('label');
        label.htmlFor = `pref-sidebar-${toggle.key}`;
        label.textContent = toggle.label;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = `pref-sidebar-${toggle.key}`;
        cb.checked = views[toggle.key] ?? true;

        row.appendChild(label);
        row.appendChild(cb);
        content.appendChild(row);
        checkboxes[toggle.key] = cb;
      }
      sidebarCheckboxes = checkboxes as typeof sidebarCheckboxes;

      const boardHeading = document.createElement('div');
      boardHeading.className = 'preferences-subheading';
      boardHeading.textContent = 'Board';
      content.appendChild(boardHeading);

      const boardMetricsRow = document.createElement('div');
      boardMetricsRow.className = 'modal-toggle-field';

      const boardMetricsLabel = document.createElement('label');
      boardMetricsLabel.htmlFor = 'pref-board-card-metrics';
      boardMetricsLabel.textContent = 'Show metrics on cards';

      boardCardMetricsCheckbox = document.createElement('input');
      boardCardMetricsCheckbox.type = 'checkbox';
      boardCardMetricsCheckbox.id = 'pref-board-card-metrics';
      boardCardMetricsCheckbox.checked = appState.preferences.boardCardMetrics ?? true;

      boardMetricsRow.appendChild(boardMetricsLabel);
      boardMetricsRow.appendChild(boardCardMetricsCheckbox);
      content.appendChild(boardMetricsRow);

      const counselHeading = document.createElement('div');
      counselHeading.className = 'preferences-subheading';
      counselHeading.textContent = 'Counsel';
      content.appendChild(counselHeading);

      const counselPrefs = appState.preferences.counsel;

      const maxTurnsRow = document.createElement('div');
      maxTurnsRow.className = 'preferences-row';
      const maxTurnsLabel = document.createElement('label');
      maxTurnsLabel.textContent = 'Max turns';
      maxTurnsLabel.htmlFor = 'pref-counsel-max-turns';
      maxTurnsRow.appendChild(maxTurnsLabel);
      const maxTurnsInput = document.createElement('input');
      maxTurnsInput.type = 'number';
      maxTurnsInput.id = 'pref-counsel-max-turns';
      maxTurnsInput.min = '3';
      maxTurnsInput.max = '30';
      maxTurnsInput.value = String(counselPrefs?.maxTurns ?? 9);
      maxTurnsInput.style.width = '100px';
      maxTurnsRow.appendChild(maxTurnsInput);
      content.appendChild(maxTurnsRow);
      counselMaxTurnsInput = maxTurnsInput;

      const styleRow = document.createElement('div');
      styleRow.className = 'modal-toggle-field';
      const styleLabel = document.createElement('label');
      styleLabel.textContent = 'Default style';
      styleRow.appendChild(styleLabel);
      counselStyleSelect = createCustomSelect(
        'pref-counsel-style',
        [
          { value: 'punchy', label: 'Punchy' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'thorough', label: 'Thorough' },
        ],
        counselPrefs?.style ?? 'balanced',
      );
      styleRow.appendChild(counselStyleSelect.element);
      content.appendChild(styleRow);

      const moderatorRow = document.createElement('div');
      moderatorRow.className = 'modal-toggle-field';
      const moderatorLabel = document.createElement('label');
      moderatorLabel.htmlFor = 'pref-counsel-moderator-enabled';
      moderatorLabel.textContent = 'Enable moderator';
      counselModeratorCheckbox = document.createElement('input');
      counselModeratorCheckbox.type = 'checkbox';
      counselModeratorCheckbox.id = 'pref-counsel-moderator-enabled';
      counselModeratorCheckbox.checked = counselPrefs?.moderatorEnabled ?? true;
      moderatorRow.appendChild(moderatorLabel);
      moderatorRow.appendChild(counselModeratorCheckbox);
      content.appendChild(moderatorRow);

      const adjudicatorRow = document.createElement('div');
      adjudicatorRow.className = 'preferences-row';
      const adjudicatorLabel = document.createElement('label');
      adjudicatorLabel.textContent = 'Adjudicator model';
      adjudicatorLabel.htmlFor = 'pref-counsel-adjudicator-model';
      adjudicatorRow.appendChild(adjudicatorLabel);
      const adjudicatorInput = document.createElement('input');
      adjudicatorInput.type = 'text';
      adjudicatorInput.id = 'pref-counsel-adjudicator-model';
      adjudicatorInput.value = counselPrefs?.adjudicatorModel ?? '';
      adjudicatorInput.placeholder = 'CLI default';
      adjudicatorInput.style.flex = '1';
      adjudicatorRow.appendChild(adjudicatorInput);
      content.appendChild(adjudicatorRow);
      counselAdjudicatorModelInput = adjudicatorInput;

      const contextPassRow = document.createElement('div');
      contextPassRow.className = 'modal-toggle-field';
      const contextPassLabel = document.createElement('label');
      contextPassLabel.htmlFor = 'pref-counsel-context-pass-default';
      contextPassLabel.textContent = 'Run context pre-pass by default';
      counselContextPassCheckbox = document.createElement('input');
      counselContextPassCheckbox.type = 'checkbox';
      counselContextPassCheckbox.id = 'pref-counsel-context-pass-default';
      counselContextPassCheckbox.checked = counselPrefs?.contextPassDefault ?? true;
      contextPassRow.appendChild(contextPassLabel);
      contextPassRow.appendChild(counselContextPassCheckbox);
      content.appendChild(contextPassRow);

    } else if (section === 'shortcuts') {
      renderShortcutsSection(content);

    } else if (section === 'setup') {
      renderSetupSection(content);

    } else if (section === 'about') {
      const aboutDiv = document.createElement('div');
      aboutDiv.className = 'about-section';

      const appName = document.createElement('div');
      appName.className = 'about-app-name';
      appName.textContent = 'Nightyard';

      const versionLine = document.createElement('div');
      versionLine.className = 'about-version';
      versionLine.textContent = 'Version: loading...';

      const updateRow = document.createElement('div');
      updateRow.className = 'about-update-row';

      const updateBtn = document.createElement('button');
      updateBtn.className = 'about-update-btn';
      updateBtn.textContent = 'Check for Updates';

      const updateStatus = document.createElement('span');
      updateStatus.className = 'about-update-status';

      updateBtn.addEventListener('click', () => {
        updateBtn.disabled = true;
        updateStatus.textContent = 'Checking...';
        window.nightyard.update.checkNow().then(() => {
          // If no update event fires within a few seconds, show "up to date"
          const timeout = setTimeout(() => {
            updateStatus.textContent = 'You\u2019re up to date.';
            updateBtn.disabled = false;
          }, 5000);
          const unsub = window.nightyard.update.onAvailable((info) => {
            clearTimeout(timeout);
            updateStatus.textContent = `Update v${info.version} available — downloading...`;
            unsub();
          });
          const unsubErr = window.nightyard.update.onError(() => {
            clearTimeout(timeout);
            updateStatus.textContent = 'Update check failed.';
            updateBtn.disabled = false;
            unsubErr();
          });
        }).catch(() => {
          updateStatus.textContent = 'Update check failed.';
          updateBtn.disabled = false;
        });
      });

      updateRow.appendChild(updateBtn);
      updateRow.appendChild(updateStatus);

      const linksDiv = document.createElement('div');
      linksDiv.className = 'about-links';

      const ghLink = document.createElement('a');
      ghLink.className = 'about-link';
      ghLink.textContent = 'GitHub';
      ghLink.href = '#';
      ghLink.addEventListener('click', (e) => { e.preventDefault(); window.nightyard.app.openExternal('https://github.com/STEIN64-BIT/nightyard'); });

      const bugLink = document.createElement('a');
      bugLink.className = 'about-link';
      bugLink.textContent = 'Report a Bug';
      bugLink.href = '#';
      bugLink.addEventListener('click', (e) => { e.preventDefault(); window.nightyard.app.openExternal('https://github.com/STEIN64-BIT/nightyard/issues'); });

      linksDiv.appendChild(ghLink);
      linksDiv.appendChild(bugLink);

      const communityDiv = document.createElement('div');
      communityDiv.className = 'about-community';
      communityDiv.append(
        'Nightyard is open source (MIT). ',
        (() => { const a = document.createElement('a'); a.className = 'about-link'; a.href = '#'; a.textContent = 'Contribute on GitHub'; a.addEventListener('click', (e) => { e.preventDefault(); window.nightyard.app.openExternal('https://github.com/STEIN64-BIT/nightyard'); }); return a; })(),
        ' \u2014 and if you find it useful, give it a star!',
      );

      const debugRow = document.createElement('div');
      debugRow.className = 'modal-toggle-field';

      const debugLabel = document.createElement('label');
      debugLabel.htmlFor = 'pref-debug-mode';
      debugLabel.textContent = 'Debug Mode';

      debugModeCheckbox = document.createElement('input');
      debugModeCheckbox.type = 'checkbox';
      debugModeCheckbox.id = 'pref-debug-mode';
      debugModeCheckbox.checked = appState.preferences.debugMode;

      debugRow.appendChild(debugLabel);
      debugRow.appendChild(debugModeCheckbox);

      aboutDiv.appendChild(appName);
      aboutDiv.appendChild(versionLine);
      aboutDiv.appendChild(updateRow);
      aboutDiv.appendChild(linksDiv);
      aboutDiv.appendChild(communityDiv);
      aboutDiv.appendChild(debugRow);
      content.appendChild(aboutDiv);

      window.nightyard.app.getVersion().then((ver) => {
        versionLine.textContent = `Version: ${ver}`;
      });
    }
  }

  function renderShortcutsSection(container: HTMLElement) {
    const grouped = shortcutManager.getAll();

    for (const [category, shortcuts] of grouped) {
      const header = document.createElement('div');
      header.className = 'shortcut-category-header';
      header.textContent = category;
      container.appendChild(header);

      for (const shortcut of shortcuts) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';

        const label = document.createElement('div');
        label.className = 'shortcut-row-label';
        label.textContent = shortcut.label;

        const keyBtn = document.createElement('button');
        keyBtn.className = 'shortcut-key-btn';
        keyBtn.textContent = displayKeys(shortcut.resolvedKeys);

        const hasOverride = shortcutManager.hasOverride(shortcut.id);
        if (hasOverride) {
          keyBtn.classList.add('customized');
        }

        const resetBtn = document.createElement('button');
        resetBtn.className = 'shortcut-reset-btn';
        resetBtn.textContent = 'Reset';
        resetBtn.title = 'Reset to default';
        if (!hasOverride) {
          resetBtn.style.visibility = 'hidden';
        }

        // Click key button to start recording
        keyBtn.addEventListener('click', () => {
          cleanupRecorder();
          keyBtn.textContent = 'Press keys...';
          keyBtn.classList.add('recording');

          const onKeydown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const accelerator = eventToAccelerator(e);
            if (!accelerator) return; // Bare modifier press

            // Save the override
            shortcutManager.setOverride(shortcut.id, accelerator);
            cleanup();
            // Re-render to update display
            renderSection('shortcuts');
          };

          const onBlur = () => {
            cleanup();
            keyBtn.textContent = displayKeys(shortcutManager.getKeys(shortcut.id));
            keyBtn.classList.remove('recording');
          };

          const cleanup = () => {
            document.removeEventListener('keydown', onKeydown, true);
            keyBtn.removeEventListener('blur', onBlur);
            keyBtn.classList.remove('recording');
            activeRecorder = null;
          };

          document.addEventListener('keydown', onKeydown, true);
          keyBtn.addEventListener('blur', onBlur);
          activeRecorder = { cleanup };
        });

        // Reset button
        resetBtn.addEventListener('click', () => {
          cleanupRecorder();
          shortcutManager.resetOverride(shortcut.id);
          renderSection('shortcuts');
        });

        row.appendChild(label);
        row.appendChild(keyBtn);
        row.appendChild(resetBtn);
        container.appendChild(row);
      }
    }
  }

  function renderCheckItem(parent: HTMLElement, opts: {
    label: string;
    description: string;
    ok: boolean;
    statusText: string;
    helpText?: string;
    onFix?: () => Promise<void>;
  }) {
    const row = document.createElement('div');
    row.className = 'setup-check-row';

    const icon = document.createElement('span');
    icon.className = opts.ok ? 'setup-check-icon ok' : 'setup-check-icon error';
    icon.textContent = opts.ok ? '\u2713' : '\u2717';

    const info = document.createElement('div');
    info.className = 'setup-check-info';

    const title = document.createElement('div');
    title.className = 'setup-check-label';
    title.textContent = opts.label;

    const desc = document.createElement('div');
    desc.className = 'setup-check-desc';
    desc.textContent = opts.description;

    info.appendChild(title);
    info.appendChild(desc);

    if (!opts.ok && opts.helpText) {
      const help = document.createElement('div');
      help.className = 'setup-check-help';
      help.textContent = opts.helpText;
      info.appendChild(help);
    }

    const status = document.createElement('div');
    status.className = opts.ok ? 'setup-check-status ok' : 'setup-check-status error';
    status.textContent = opts.statusText;

    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(status);

    const { onFix } = opts;
    if (onFix) {
      const btn = document.createElement('button');
      btn.className = 'setup-fix-btn';
      btn.textContent = 'Fix';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Fixing\u2026';
        try {
          await onFix();
        } catch {
          btn.disabled = false;
          btn.textContent = 'Fix';
        }
      });
      row.appendChild(btn);
    }

    parent.appendChild(row);
  }

  async function fixAndRerender(providerId?: string) {
    await window.nightyard.settings.reinstall(providerId);
    renderSection('setup');
  }

  function renderProviderHeader(parent: HTMLElement, displayName: string) {
    const header = document.createElement('div');
    header.className = 'setup-provider-header';
    header.textContent = displayName;
    parent.appendChild(header);
  }

  async function fetchProviderStatuses(): Promise<ProviderStatus[]> {
    const providers = await window.nightyard.provider.listProviders();
    return Promise.all(
      providers.map(meta =>
        Promise.all([
          window.nightyard.settings.validate(meta.id),
          window.nightyard.provider.checkBinary(meta.id),
        ]).then(([validation, binaryOk]) => ({ meta, validation, binaryOk })),
      ),
    );
  }

  async function renderSetupSection(container: HTMLElement) {
    const section = document.createElement('div');
    section.className = 'setup-section';

    const loading = document.createElement('div');
    loading.className = 'setup-loading';
    loading.textContent = 'Checking configuration\u2026';
    section.appendChild(loading);
    container.appendChild(section);

    const results = await fetchProviderStatuses();

    if (currentSection !== 'setup') return;

    applySetupBadge(results.some(hasProviderIssue));

    section.innerHTML = '';

    for (const { meta, validation, binaryOk } of results) {
      renderProviderHeader(section, meta.displayName);

      renderCheckItem(section, {
        label: meta.displayName,
        description: `The ${meta.binaryName} binary must be installed for sessions to work.`,
        ok: binaryOk,
        statusText: binaryOk ? 'Installed' : 'Not found',
        helpText: binaryOk ? undefined : `${meta.binaryName} not found.`,
      });

      if (!binaryOk) continue;

      const { capabilities } = meta;

      if (capabilities.costTracking || capabilities.contextWindow) {
        const slOk = validation.statusLine === 'nightyard';
        let slStatus = 'Configured';
        if (validation.statusLine === 'missing') slStatus = 'Not configured';
        else if (validation.statusLine === 'foreign') slStatus = 'Overwritten by another tool';

        renderCheckItem(section, {
          label: 'Status Line',
          description: 'Required for cost tracking and context window monitoring.',
          ok: slOk,
          statusText: slStatus,
          onFix: slOk ? undefined : () => fixAndRerender(meta.id),
        });
      }

      if (capabilities.hookStatus) {
        const hooksOk = validation.hooks === 'complete';
        let hooksStatus = 'All hooks installed';
        if (validation.hooks === 'missing') hooksStatus = 'No hooks installed';
        else if (validation.hooks === 'partial') hooksStatus = 'Some hooks missing';

        renderCheckItem(section, {
          label: 'Session Hooks',
          description: 'Required for session activity tracking.',
          ok: hooksOk,
          statusText: hooksStatus,
          onFix: hooksOk ? undefined : () => fixAndRerender(meta.id),
        });

        const hookList = document.createElement('div');
        hookList.className = 'setup-hook-details';
        for (const [event, installed] of Object.entries(validation.hookDetails)) {
          const item = document.createElement('div');
          item.className = 'setup-hook-item';
          const icon = document.createElement('span');
          icon.className = installed ? 'setup-check-icon ok' : 'setup-check-icon error';
          icon.textContent = installed ? '\u2713' : '\u2717';
          const name = document.createElement('span');
          name.className = 'setup-hook-name';
          name.textContent = event;
          item.appendChild(icon);
          item.appendChild(name);
          hookList.appendChild(item);
        }
        section.appendChild(hookList);

        if (capabilities.costTracking && validation.statusLine !== 'nightyard' && !hooksOk) {
          const fixAllRow = document.createElement('div');
          fixAllRow.className = 'setup-fix-all-row';

          const fixAllBtn = document.createElement('button');
          fixAllBtn.className = 'setup-fix-btn';
          fixAllBtn.textContent = 'Fix All';
          fixAllBtn.addEventListener('click', async () => {
            fixAllBtn.disabled = true;
            fixAllBtn.textContent = 'Fixing\u2026';
            try {
              await fixAndRerender(meta.id);
            } catch {
              fixAllBtn.disabled = false;
              fixAllBtn.textContent = 'Fix All';
            }
          });

          fixAllRow.appendChild(fixAllBtn);
          section.appendChild(fixAllRow);
        }
      }
    }
  }

  function applySetupBadge(hasIssue: boolean) {
    const setupItem = menuItems.get('setup');
    if (setupItem) {
      setupItem.classList.toggle('has-badge', hasIssue);
    }
  }

  async function updateSetupBadge() {
    const results = await fetchProviderStatuses();
    applySetupBadge(results.some(hasProviderIssue));
  }
  updateSetupBadge();

  // Menu click handler
  menu.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.preferences-menu-item') as HTMLElement | null;
    if (target && target.dataset.section) {
      renderSection(target.dataset.section as Section);
    }
  });

  // Show initial section
  renderSection('general');

  overlay.style.display = '';

  const save = () => {
    if (soundCheckbox) {
      appState.setPreference('soundOnSessionWaiting', soundCheckbox.checked);
    }
    if (notificationsCheckbox) {
      appState.setPreference('notificationsDesktop', notificationsCheckbox.checked);
    }
    if (historyCheckbox) {
      appState.setPreference('sessionHistoryEnabled', historyCheckbox.checked);
    }
    if (insightsCheckbox) {
      appState.setPreference('insightsEnabled', insightsCheckbox.checked);
    }
    if (autoTitleCheckbox) {
      appState.setPreference('autoTitleEnabled', autoTitleCheckbox.checked);
    }
    if (confirmCloseCheckbox) {
      appState.setPreference('confirmCloseWorkingSession', confirmCloseCheckbox.checked);
    }
    if (copyOnSelectCheckbox) {
      appState.setPreference('copyOnSelect', copyOnSelectCheckbox.checked);
    }
    if (defaultProviderSelect) {
      appState.setPreference('defaultProvider', defaultProviderSelect.getValue() as ProviderId);
    }
    if (themeSelect) {
      appState.setPreference('theme', themeSelect.getValue() as 'dark' | 'light');
    }
    if (debugModeCheckbox && debugModeCheckbox.checked !== appState.preferences.debugMode) {
      appState.setPreference('debugMode', debugModeCheckbox.checked);
      window.nightyard.menu.rebuild(debugModeCheckbox.checked);
    }
    if (globalDefaultArgsInput) {
      appState.setPreference('globalDefaultArgs', globalDefaultArgsInput.value.trim());
    }
    if (sleepyBinInput) {
      const v = sleepyBinInput.value.trim();
      appState.setPreference('sleepyBin', v.length > 0 ? v : undefined);
    }
    if (sleepyDashboardPortInput) {
      const n = parseInt(sleepyDashboardPortInput.value, 10);
      appState.setPreference('sleepyDashboardPort', Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : 8910);
    }
    if (wakeyMaxIterationsInput) {
      const n = parseInt(wakeyMaxIterationsInput.value, 10);
      appState.setPreference('wakeyMaxIterations', Number.isFinite(n) && n > 0 && n <= 500 ? n : 50);
    }
    if (wakeySystemPromptInput) {
      const v = wakeySystemPromptInput.value.trim();
      appState.setPreference('wakeySystemPrompt', v.length > 0 ? v : undefined);
    }
    if (wakeyWatchdogMinutesInput) {
      const n = parseInt(wakeyWatchdogMinutesInput.value, 10);
      appState.setPreference('wakeyWatchdogMinutes', Number.isFinite(n) && n >= 1 ? n : 3);
    }
    if (wakeyModelInput) {
      const v = wakeyModelInput.value.trim();
      appState.setPreference('wakeyModel', v.length > 0 ? v : undefined);
    }
    if (vaultPathInput) {
      const v = vaultPathInput.value.trim();
      appState.setPreference('vaultPath', v.length > 0 ? v : undefined);
      window.nightyard.vault.setPath(v);
    }
    if (sidebarCheckboxes) {
      appState.setPreference('sidebarViews', {
        gitPanel: sidebarCheckboxes.gitPanel.checked,
        sessionHistory: sidebarCheckboxes.sessionHistory.checked,
        costFooter: sidebarCheckboxes.costFooter.checked,
        fileTree: sidebarCheckboxes.fileTree.checked,
      });
    }
    if (boardCardMetricsCheckbox && boardCardMetricsCheckbox.checked !== (appState.preferences.boardCardMetrics ?? true)) {
      appState.setPreference('boardCardMetrics', boardCardMetricsCheckbox.checked);
    }
    if (counselMaxTurnsInput) {
      const maxTurnsRaw = parseInt(counselMaxTurnsInput.value, 10);
      const maxTurns = Number.isFinite(maxTurnsRaw) && maxTurnsRaw >= 3 && maxTurnsRaw <= 30 ? maxTurnsRaw : 9;
      const adjudicatorModel = counselAdjudicatorModelInput?.value.trim() ?? '';
      appState.setPreference('counsel', {
        maxTurns,
        style: (counselStyleSelect?.getValue() as CounselStyle) ?? 'balanced',
        moderatorEnabled: counselModeratorCheckbox?.checked ?? true,
        adjudicatorModel: adjudicatorModel.length > 0 ? adjudicatorModel : undefined,
        contextPassDefault: counselContextPassCheckbox?.checked ?? true,
      });
    }
  };

  const close = () => {
    overlay.style.display = 'none';
    cleanupFn?.();
    cleanupFn = null;
  };

  const handleConfirm = () => {
    save();
    close();
  };

  const handleCancel = () => {
    document.documentElement.dataset.theme = originalTheme;
    close();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    // Don't intercept if we're recording a shortcut
    if (activeRecorder) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  btnConfirm.addEventListener('click', handleConfirm);
  btnCancel.addEventListener('click', handleCancel);
  document.addEventListener('keydown', handleKeydown);

  cleanupFn = () => {
    cleanupRecorder();
    zoomPrefUnsub?.();
    zoomPrefUnsub = null;
    if (defaultProviderSelect) defaultProviderSelect.destroy();
    if (themeSelect) themeSelect.destroy();
    if (zoomSelect) zoomSelect.destroy();
    if (counselStyleSelect) counselStyleSelect.destroy();
    btnConfirm.removeEventListener('click', handleConfirm);
    btnCancel.removeEventListener('click', handleCancel);
    document.removeEventListener('keydown', handleKeydown);
  };
}
