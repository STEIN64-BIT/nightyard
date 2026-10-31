const MAX = 5;
const bySession = new Map<string, string[]>();

export function recordPrompt(sessionId: string, prompt: string): void {
  const list = bySession.get(sessionId) ?? [];
  list.unshift(prompt);
  bySession.set(sessionId, list.slice(0, MAX));
}

export function recentPrompts(sessionId: string): string[] {
  return [...(bySession.get(sessionId) ?? [])];
}

export function clearHistory(sessionId: string): void {
  bySession.delete(sessionId);
}
