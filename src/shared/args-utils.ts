/**
 * Merge a user-global default-args string with a per-project one.
 * Tokens are split on whitespace; exact-token duplicates from the project
 * side are dropped. Order: global tokens first, then project-only tokens.
 */
export function mergeDefaultArgs(global: string | undefined, project: string | undefined): string {
  const globalStr = (global ?? '').trim();
  const projectStr = (project ?? '').trim();

  if (!globalStr && !projectStr) {
    return '';
  }

  const left = globalStr ? globalStr.split(/\s+/).filter(Boolean) : [];
  const right = projectStr ? projectStr.split(/\s+/).filter(Boolean) : [];

  // Build a set of exact (token, nextToken) pairs from global for deduplication
  const seenPairs = new Set<string>();
  for (let i = 0; i < left.length; i++) {
    const pair = i < left.length - 1 ? `${left[i]} ${left[i + 1]}` : left[i];
    seenPairs.add(pair);
  }

  const result = [...left];

  // Add from project only if the (token, nextToken) pair wasn't in global
  for (let i = 0; i < right.length; i++) {
    const pair = i < right.length - 1 ? `${right[i]} ${right[i + 1]}` : right[i];
    if (!seenPairs.has(pair)) {
      result.push(right[i]);
      seenPairs.add(pair);
    }
  }

  return result.join(' ');
}
