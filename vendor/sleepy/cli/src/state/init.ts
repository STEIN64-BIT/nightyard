import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { sleepyPaths } from '../paths.js';

const DEFAULT_RULES = `# SLEEPY_RULES.md

This file defines the scope and safety rules for sleepy runs in this project.
The orchestrator reads this file at the start of every session. Edit freely.

## Scope

Uncomment and customize:

<!--
- Work only inside: src/, docs/, tests/
- Do not touch: infra/, .github/workflows/
- Goals (priority hints, not mandatory):
  - Improve test coverage
  - UI polish
- Do NOT:
  - Rewrite the auth module
-->

## Allowed network mutations

Network reads (GET, search, downloads) are always allowed.
Network mutations (POST/PUT/DELETE) are denied unless listed here.

<!--
- https://api.openai.com/**
- https://slack.com/api/chat.postMessage
-->

## Notes

Anything else the orchestrator should know about this project.
`;

export interface InitResult {
  created: boolean;
  root: string;
}

export async function initSleepyDir(projectRoot: string): Promise<InitResult> {
  const paths = sleepyPaths(projectRoot);

  let alreadyExisted = false;
  try {
    await access(paths.root);
    alreadyExisted = true;
  } catch {
    // doesn't exist — we'll create it
  }

  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(path.join(paths.artifactsDir, 'research'), { recursive: true });
  await mkdir(path.join(paths.artifactsDir, 'content'), { recursive: true });
  await mkdir(path.join(paths.artifactsDir, 'plans'), { recursive: true });
  await mkdir(path.join(paths.artifactsDir, 'findings'), { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });

  try {
    await access(paths.rulesMd);
  } catch {
    await writeFile(paths.rulesMd, DEFAULT_RULES, 'utf8');
  }

  return { created: !alreadyExisted, root: paths.root };
}
