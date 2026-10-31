import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

export interface AssistantTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface AssistantTurn {
  uuid: string;
  timestamp: string;
  usage: AssistantTurnUsage;
}

/**
 * Parses a Claude Code session JSONL file and returns one entry per
 * assistant turn that carried token usage. Non-assistant lines, malformed
 * lines, and assistant lines without usage are skipped. Missing files
 * return an empty array (not an error) — callers can poll growing files.
 */
export async function parseSessionFile(file: string): Promise<AssistantTurn[]> {
  let stream;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    return [];
  }

  const turns: AssistantTurn[] = [];
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // skip garbage
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { type?: unknown }).type !== 'assistant'
      ) {
        continue;
      }
      const obj = parsed as {
        type: 'assistant';
        uuid?: string;
        timestamp?: string;
        message?: { usage?: Partial<Record<string, number>> };
      };
      const usage = obj.message?.usage;
      if (!usage) continue;

      turns.push({
        uuid: obj.uuid ?? '',
        timestamp: obj.timestamp ?? '',
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        },
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return turns;
}

export function sumTokens(turns: AssistantTurn[]): number {
  let total = 0;
  for (const t of turns) {
    total +=
      t.usage.inputTokens +
      t.usage.outputTokens +
      t.usage.cacheCreationInputTokens +
      t.usage.cacheReadInputTokens;
  }
  return total;
}
