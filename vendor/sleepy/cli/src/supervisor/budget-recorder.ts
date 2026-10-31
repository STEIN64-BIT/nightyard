import { parseSessionFile, sumTokens } from '../session/jsonl-parser.js';
import { recordTokens } from '../state/budget.js';

export interface RecordIterationInput {
  projectRoot: string;
  sessionFile: string | null;
  iterationDurationMs: number;
  at: Date;
}

export interface RecordIterationResult {
  tokensRecorded: number;
}

export async function recordIterationTokens(
  input: RecordIterationInput,
): Promise<RecordIterationResult> {
  let tokens = 0;
  if (input.sessionFile) {
    const turns = await parseSessionFile(input.sessionFile);
    tokens = sumTokens(turns);
  }
  await recordTokens(input.projectRoot, {
    tokens,
    iterationDeltaMs: input.iterationDurationMs,
    at: input.at,
  });
  return { tokensRecorded: tokens };
}
