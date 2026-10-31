import type { CodexAccount } from '../../shared/types';

export interface CodexSessionMenuEntry {
  text: string;
  /** CODEX_HOME id to spawn under; undefined = let the project's remembered account decide. */
  account: string | undefined;
  /** Full account label (id + login email) for the tooltip. */
  title: string | undefined;
}

/**
 * Items for Codex in the "+" dropdown. With a single login the generic quick
 * item stays as it was; once a second CODEX_HOME is logged in (see
 * main/codex-homes.ts) every login gets its own item, so picking the account is
 * one click instead of a trip through the New Custom Session dialog.
 */
export function codexSessionMenuEntries(displayName: string, accounts: CodexAccount[]): CodexSessionMenuEntry[] {
  const base = `New ${displayName} Session`;
  if (accounts.length <= 1) return [{ text: base, account: undefined, title: undefined }];
  return accounts.map(a => ({ text: `${base} · ${a.id}`, account: a.id, title: a.label }));
}
