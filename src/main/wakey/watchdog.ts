import type { WakeyPhase } from './run-store';

export interface WatchdogInput {
  phase: WakeyPhase; stopped: boolean;
  cooldownUntil: number; lastSupervisionAt: number;
  lastHookEventAt: number; lastPtyOutputAt: number;
  startedAt: number; now: number; quietMinutes: number;
}

export function shouldForceSupervision(i: WatchdogInput): boolean {
  if (i.stopped || i.phase !== 'idle') return false;
  if (i.now < i.cooldownUntil) return false;
  const lastActivity = Math.max(i.lastSupervisionAt, i.lastHookEventAt, i.lastPtyOutputAt, i.startedAt);
  return i.now - lastActivity >= i.quietMinutes * 60_000;
}
