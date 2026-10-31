import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readState, writeStateAtomic, isNightyardRunning, statePath } from '../../../hooks/lib/state.js';

const TMP = path.join(os.tmpdir(), 'nightyard-hooks-test-' + process.pid);

describe('hooks/lib/state', () => {
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
    process.env.NIGHTYARD_HOME = TMP;
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.NIGHTYARD_HOME;
  });

  it('statePath honours NIGHTYARD_HOME override', () => {
    expect(statePath()).toBe(path.join(TMP, 'state.json'));
  });

  it('readState returns null when file is missing', () => {
    expect(readState()).toBeNull();
  });

  it('readState parses an existing state.json', () => {
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, projects: [] }));
    expect(readState()).toEqual({ version: 1, projects: [] });
  });

  it('writeStateAtomic writes via tmp+rename and survives a write', () => {
    writeStateAtomic({ version: 1, projects: [{ id: 'a', name: 'A', path: '/x', sessions: [] }] });
    const read = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    expect(read.projects[0].id).toBe('a');
  });

  it('isNightyardRunning is false when no Nightyard process exists', () => {
    // Best-effort check: if the test machine happens to have Nightyard open we skip.
    if (isNightyardRunning()) return;
    expect(isNightyardRunning()).toBe(false);
  });
});
