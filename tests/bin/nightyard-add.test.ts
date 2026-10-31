import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const TMP = path.join(os.tmpdir(), 'nightyard-add-test-' + process.pid);
const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'nightyard-add.js');

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`node "${BIN}" ${args.join(' ')}`, { encoding: 'utf-8', env: { ...process.env, NIGHTYARD_HOME: TMP } });
    return { code: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { code: err.status, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  }
}

function readState() {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf-8'));
}

describe('nightyard-add', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('creates state.json on first add', () => {
    const target = path.join(TMP, 'proj-a');
    fs.mkdirSync(target);
    const r = run([target]);
    expect(r.code).toBe(0);
    const s = readState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].path).toBe(target);
    expect(s.projects[0].defaultArgs).toBeUndefined();
    expect(s.projects[0].board.columns.map((c: any) => c.title)).toEqual(['Backlog', 'Ready', 'Running', 'Done']);
  });

  it('uses --name when provided', () => {
    const target = path.join(TMP, 'proj-b');
    fs.mkdirSync(target);
    const r = run([target, '--name', 'Fancy']);
    expect(r.code).toBe(0);
    expect(readState().projects[0].name).toBe('Fancy');
  });

  it('refuses to add a duplicate path', () => {
    const target = path.join(TMP, 'proj-c');
    fs.mkdirSync(target);
    expect(run([target]).code).toBe(0);
    const r = run([target]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already in state/i);
    expect(readState().projects).toHaveLength(1);
  });

  it('refuses when path does not exist', () => {
    const r = run([path.join(TMP, 'nope')]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not exist/i);
  });
});
