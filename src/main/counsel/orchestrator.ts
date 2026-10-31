import { randomUUID } from 'crypto';
import type {
  CounselEvent, CounselResult, CounselStartConfig,
} from '../../shared/types';
import { COUNSEL_SEATS } from '../../shared/types';
import { buildContextPassPrompt, buildTurnPrompt } from './prompts';
import { moderate } from './moderator';
import { adjudicate, buildFallbackVerdict } from './adjudicator';
import type { CounselRunner } from './runner';

export interface CounselHandle {
  stop(): void;
  result: Promise<CounselResult>;
}

interface CounselDeps {
  runner: CounselRunner;
  emit: (e: CounselEvent) => void;
  makeId?: () => string;
  now?: () => number;
}

export function launchCounsel(config: CounselStartConfig, deps: CounselDeps): CounselHandle {
  let stopped = false;
  const result = runCounsel(config, deps, () => stopped);
  return {
    stop() {
      stopped = true;
      deps.runner.abortActive();
    },
    result,
  };
}

async function runCounsel(
  config: CounselStartConfig,
  deps: CounselDeps,
  isStopped: () => boolean,
): Promise<CounselResult> {
  const { runner } = deps;
  const makeId = deps.makeId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const emit = (e: CounselEvent) => {
    try { deps.emit(e); } catch { /* UI forwarding must never kill the debate */ }
  };

  const result: CounselResult = {
    counselId: config.counselId,
    prompt: config.prompt,
    seats: config.seats,
    style: config.style,
    turns: [],
    moderatorNotes: [],
    stoppedReason: 'max-turns',
    startedAt: now(),
  };

  emit({ type: 'start', counselId: config.counselId, prompt: config.prompt, seats: config.seats });

  if (config.contextPass) {
    try {
      const brief = await runner.runContextPass(buildContextPassPrompt(config.prompt), config.projectPath);
      result.contextBrief = brief;
      emit({ type: 'context', counselId: config.counselId, brief });
    } catch {
      emit({ type: 'context', counselId: config.counselId, brief: null });
    }
  }

  let redirectNote: string | null = null;

  for (let turnIndex = 0; turnIndex < config.maxTurns; turnIndex++) {
    if (isStopped()) { result.stoppedReason = 'stopped'; break; }

    const seat = COUNSEL_SEATS[turnIndex % 3];
    const round = Math.floor(turnIndex / 3) + 1;
    const turnId = makeId();
    emit({ type: 'turn-start', counselId: config.counselId, turnId, seat, round });

    const turnPrompt = buildTurnPrompt({
      question: config.prompt,
      contextBrief: result.contextBrief ?? null,
      turns: result.turns,
      seats: config.seats,
      seat,
      redirectNote,
      style: config.style,
    });
    redirectNote = null; // a redirect is consumed exactly once

    let text: string;
    try {
      text = await runner.runTurn(
        config.seats[seat], config.systemPrompts[seat], turnPrompt,
        (chunk) => emit({ type: 'turn-delta', counselId: config.counselId, turnId, chunk }),
      );
    } catch (err) {
      if (isStopped()) { result.stoppedReason = 'stopped'; break; }
      result.stoppedReason = 'error';
      emit({ type: 'error', counselId: config.counselId, message: err instanceof Error ? err.message : String(err) });
      break;
    }
    if (isStopped()) { result.stoppedReason = 'stopped'; break; }

    result.turns.push({ turnId, seat, round, text });
    emit({ type: 'turn-end', counselId: config.counselId, turnId, seat, fullText: text });

    const completed = result.turns.length;
    if (
      config.moderatorEnabled && seat === 'C' &&
      completed >= config.minTurnsBeforeStop && completed < config.maxTurns
    ) {
      emit({ type: 'phase', counselId: config.counselId, phase: 'moderating' });
      const m = await moderate((p) => runner.runOneShot(p), config.prompt, result.turns, config.seats);
      result.moderatorNotes.push({ afterRound: round, decision: m.decision, note: m.note });
      emit({ type: 'moderator', counselId: config.counselId, decision: m.decision, note: m.note, round });
      if (m.decision === 'redirect') redirectNote = m.note;
      if (m.decision === 'converged') { result.stoppedReason = 'converged'; break; }
    }
  }

  // ALWAYS adjudicate — even after errors, stop, or convergence.
  emit({ type: 'phase', counselId: config.counselId, phase: 'adjudicating' });
  try {
    result.verdict = await adjudicate(
      (p) => runner.runOneShot(p, { model: config.adjudicatorModel }),
      config.prompt, result.turns, config.seats,
    );
  } catch {
    result.verdict = buildFallbackVerdict(result.turns);
  }
  result.finishedAt = now();
  emit({ type: 'verdict', counselId: config.counselId, verdict: result.verdict });
  emit({ type: 'done', counselId: config.counselId, result });
  return result;
}
