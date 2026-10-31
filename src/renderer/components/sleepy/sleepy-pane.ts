import { appState, sleepyAutoStartSessions, sleepyInitialPrompts, sleepyInitialArgs } from '../../state.js';
import type { ProjectRecord, SessionRecord } from '../../../shared/types.js';

/** Sleepy ships inside Nightyard. Preferences → Sleepy can point at your own
 *  checkout instead; empty means the built-in one (resolved in the main process).
 *  Read at run time so a path set after the pane opened is picked up. */
function configuredSleepyBin(): string {
  return appState.preferences.sleepyBin?.trim() ?? '';
}

export interface SleepyPaneHandle {
  pane: HTMLElement;
  unsubGoal: () => void;
}

export function buildSleepyPane(project: ProjectRecord, session: SessionRecord): SleepyPaneHandle {
  const pane = document.createElement('div');
  pane.className = 'sleepy-pane';

  const header = document.createElement('div');
  header.className = 'sleepy-pane-header';
  header.innerHTML = `
    <span class="sleepy-pane-glyph">(-.-) zZz</span>
    <span class="sleepy-pane-title">SLEEPY · ${escapeHtml(project.name)}</span>
    <span class="sleepy-pane-status" data-status>idle</span>
  `;
  pane.appendChild(header);
  const statusEl = header.querySelector('[data-status]') as HTMLSpanElement;

  const promptRow = document.createElement('div');
  promptRow.className = 'sleepy-prompt-row';

  const promptInput = document.createElement('textarea');
  promptInput.className = 'sleepy-prompt-input';
  promptInput.placeholder = 'What should Sleepy improve? Give it a clear outcome.';
  promptInput.setAttribute('aria-label', 'Goal for Sleepy');
  promptInput.value = 'Find and fix the most useful improvements in this project';
  promptRow.appendChild(promptInput);

  const goBtn = document.createElement('button');
  goBtn.className = 'sleepy-go-btn';
  goBtn.textContent = 'Start run';
  promptRow.appendChild(goBtn);

  pane.appendChild(promptRow);
  const options = document.createElement('div');
  options.className = 'sleepy-run-options';
  options.innerHTML = `
    <label>Agent <select data-mode aria-label="Sleepy agent">
      <option value="opus">Sleepy · Opus</option><option value="codex">Sleepy · Codex</option><option value="duo">Duo · Codex + Opus</option>
    </select></label>
    <label>Run for <select data-duration aria-label="Sleepy duration">
      <option value="30m">30 minutes</option><option value="2h" selected>2 hours</option><option value="8h">8 hours</option>
    </select></label>
    <span data-mode-help>Changes go to the review queue.</span>`;
  pane.appendChild(options);
  const modeSelect = options.querySelector<HTMLSelectElement>('[data-mode]')!;
  const durationSelect = options.querySelector<HTMLSelectElement>('[data-duration]')!;
  const modeHelp = options.querySelector<HTMLElement>('[data-mode-help]')!;
  const updateModeHelp = () => { modeHelp.textContent = modeSelect.value === 'duo'
    ? 'Codex builds; Opus reviews alongside it. Changes go to the review queue.'
    : modeSelect.value === 'codex'
      ? 'Codex works on its own using your Codex allowance. Changes go to the review queue.'
      : 'Opus works on its own using your Claude allowance. Changes go to the review queue.'; };
  modeSelect.addEventListener('change', updateModeHelp);
  updateModeHelp();
  function consumeInitialArgs(): void {
    const args = sleepyInitialArgs.get(session.id);
    sleepyInitialArgs.delete(session.id);
    if (!args) return;
    const providerIndex = args.indexOf('--provider');
    modeSelect.value = args.includes('--team') ? 'duo' : providerIndex >= 0 && args[providerIndex + 1] === 'codex' ? 'codex' : 'opus';
    const i = args.indexOf('--duration');
    if (i >= 0 && ['30m', '2h', '8h'].includes(args[i + 1])) durationSelect.value = args[i + 1];
    updateModeHelp();
  }
  consumeInitialArgs();

  const output = document.createElement('div');
  output.className = 'sleepy-output';
  output.textContent = '';
  pane.appendChild(output);

  const queueRow = document.createElement('div');
  queueRow.className = 'sleepy-queue-row';
  queueRow.innerHTML = `
    <label>Queue item:</label>
    <input type="number" class="sleepy-queue-input" min="1" placeholder="N" data-n>
    <button class="sleepy-queue-btn apply" data-action="apply">apply</button>
    <button class="sleepy-queue-btn discard" data-action="discard">discard</button>
    <button class="sleepy-queue-btn" data-action="why">why</button>
    <button class="sleepy-queue-btn" data-action="dashboard" style="margin-left:auto;">open dashboard</button>
  `;
  pane.appendChild(queueRow);

  const dashboardPort = appState.preferences.sleepyDashboardPort ?? 8910;

  let cleanupOnData: (() => void) | null = null;
  let cleanupOnExit: (() => void) | null = null;
  let running = false;
  let stopping = false;
  let disposed = false;
  let autoStartTimer: ReturnType<typeof setTimeout> | undefined;
  let currentCommand = '';
  let runStartedAt = 0;
  let accumulatedOutput = '';

  function appendOutput(text: string, stream: 'stdout' | 'stderr'): void {
    text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    accumulatedOutput = (accumulatedOutput + text).slice(-100_000);
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
    const node = document.createElement('span');
    if (stream === 'stderr') node.className = 'stderr';
    node.textContent = text;
    output.appendChild(node);
    while (output.childNodes.length > 600) output.firstChild?.remove();
    if (follow) output.scrollTop = output.scrollHeight;
  }

  function appendStatusLine(text: string): void {
    if (disposed) return;
    const node = document.createElement('div');
    node.className = 'sleepy-status-line';
    node.textContent = text;
    output.appendChild(node);
    output.scrollTop = output.scrollHeight;
  }

  function setStatus(status: string): void {
    statusEl.textContent = status;
    statusEl.setAttribute('role', 'status');
  }

  function disposeListeners(): void {
    cleanupOnData?.();
    cleanupOnExit?.();
    cleanupOnData = null;
    cleanupOnExit = null;
  }

  function updateControls(): void {
    goBtn.textContent = stopping ? 'Stopping…' : running ? 'Stop' : 'Start run';
    goBtn.disabled = stopping;
    promptInput.disabled = running;
    modeSelect.disabled = running;
    durationSelect.disabled = running;
    for (const button of queueRow.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      button.disabled = running && button.dataset.action !== 'dashboard';
    }
  }

  async function runSleepy(args: string[]): Promise<void> {
    if (running || disposed) return;
    const sleepyBin = configuredSleepyBin();
    disposeListeners();
    accumulatedOutput = '';
    running = true;
    stopping = false;
    currentCommand = args[0];
    runStartedAt = Date.now();
    updateControls();
    appendOutput(`\n$ sleepy ${args.join(' ')}\n`, 'stdout');
    setStatus(currentCommand === 'start' ? 'Working…' : `${currentCommand}…`);
    cleanupOnData = window.nightyard.sleepy.onData(session.id, ({ chunk, stream }) => appendOutput(chunk, stream));
    cleanupOnExit = window.nightyard.sleepy.onExit(session.id, ({ code }) => {
      const wasStopped = stopping;
      setStatus(wasStopped ? 'Stopped' : code === 0 ? 'Finished' : `Failed (exit ${code ?? 'signal'})`);
      running = false;
      stopping = false;
      updateControls();
      appendStatusLine(`Run ended after ${Math.max(1, Math.round((Date.now() - runStartedAt) / 1000))} seconds.`);
      disposeListeners();
      if (code === 0 && currentCommand === 'start') {
        const summary = accumulatedOutput.slice(-20000);
        window.nightyard.sleepy.distill({
          sessionName: session.name,
          projectName: project.name,
          summary,
        }).then((relPath) => {
          appendStatusLine(`Distilled → ${relPath}`);
        }).catch((err: unknown) => {
          console.warn('[sleepy] distill failed:', err);
          const msg = err instanceof Error ? err.message : String(err);
          appendStatusLine(/knowledge vault/i.test(msg)
            ? 'Not distilled: set Preferences → Knowledge vault path to keep run summaries as notes'
            : 'Distill failed');
        });
      }
    });
    try {
      await window.nightyard.sleepy.spawn(session.id, { sleepyBin, args, cwd: project.path });
    } catch (err: any) {
      appendOutput(`\n[spawn error] ${err.message}\n`, 'stderr');
      setStatus('error');
      running = false;
      stopping = false;
      updateControls();
      disposeListeners();
    }
  }

  goBtn.addEventListener('click', async () => {
    if (running) {
      if (stopping) return;
      stopping = true;
      setStatus('Stopping… waiting for workers');
      updateControls();
      await window.nightyard.sleepy.kill(session.id).catch((err: Error) => {
        stopping = false; updateControls();
        setStatus('Could not stop'); appendStatusLine(err.message);
      });
      return;
    }
    const text = promptInput.value.trim();
    if (!text) return;
    const args = ['start', '--goal', text, '--duration', durationSelect.value];
    if (modeSelect.value === 'duo') args.push('--team');
    else args.push('--provider', modeSelect.value === 'codex' ? 'codex' : 'opus');
    void runSleepy(args);
  });

  queueRow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.dataset.action;
    if (!action) return;
    const nInput = queueRow.querySelector<HTMLInputElement>('[data-n]')!;

    if (action === 'dashboard') {
      window.nightyard.app.openExternal(`http://localhost:${dashboardPort}`);
      return;
    }

    if (running) return;
    const n = nInput.value.trim();
    if (!/^[1-9]\d*$/.test(n) || !Number.isSafeInteger(Number(n))) {
      appendOutput('[error] enter a positive whole queue item number\n', 'stderr');
      return;
    }
    void runSleepy([action, n]);
  });

  // Auto-start: if this session was opened with autoStart, trigger Go after the pane is in the DOM.
  if (sleepyAutoStartSessions.has(session.id)) {
    sleepyAutoStartSessions.delete(session.id);
    const initialPrompt = sleepyInitialPrompts.get(session.id);
    if (initialPrompt) {
      sleepyInitialPrompts.delete(session.id);
      promptInput.value = initialPrompt;
    }
    autoStartTimer = setTimeout(() => { if (!disposed) goBtn.click(); }, 0);
  }

  // When an existing pane receives a new goal (e.g. "Plan with Sleepy" clicked again),
  // consume the one-shot Maps and either start immediately (idle) or show a notice (busy).
  const unsubGoal = appState.on('sleepy-goal-updated', (payload: unknown) => {
    const data = payload as { sessionId?: string } | undefined;
    if (data?.sessionId !== session.id) return;
    const newGoal = sleepyInitialPrompts.get(session.id);
    const shouldAutoStart = sleepyAutoStartSessions.has(session.id);
    // Consume one-shot entries.
    sleepyAutoStartSessions.delete(session.id);
    if (newGoal) sleepyInitialPrompts.delete(session.id);
    if (running) {
      sleepyInitialArgs.delete(session.id);
      appendStatusLine('Sleepy busy — try after this run');
      return;
    }
    consumeInitialArgs();
    if (newGoal) promptInput.value = newGoal;
    if (shouldAutoStart) goBtn.click();
  });

  // unsubGoal is returned so destroySleepyPane (sleepy-instance.ts) can call it.
  // Detach/reattach cycles (swarm relayout, project switching) must NOT kill the subscription.
  return { pane, unsubGoal: () => {
    disposed = true; clearTimeout(autoStartTimer); disposeListeners(); unsubGoal();
    sleepyAutoStartSessions.delete(session.id);
    sleepyInitialPrompts.delete(session.id);
    sleepyInitialArgs.delete(session.id);
  } };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
