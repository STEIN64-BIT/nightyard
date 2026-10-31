import { vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
  tmpdir: () => '/tmp',
}));

vi.mock('./hook-commands', () => ({
  installHookScripts: vi.fn(),
  installEventScript: vi.fn(),
  statusCmd: vi.fn((e: string, s: string, _v: string, marker: string) => `sh -c 'echo ${e}:${s} > "$NIGHTYARD_SESSION_ID.status"' ${marker}`),
  captureSessionIdCmd: vi.fn((_v: string, marker: string) => `capture .sessionid ${marker}`),
  captureToolFailureCmd: vi.fn((_v: string, marker: string) => `capture-toolfailure ${marker}`),
  wrapPythonHookCmd: vi.fn((name: string, _code: string, marker: string) => `capture-event ${name} ${marker}`),
}));

import * as fs from 'fs';
import * as path from 'path';
import { installKimiHooks, validateKimiHooks, cleanupKimiHooks, KIMI_HOOK_MARKER, KIMI_BLOCK_BEGIN, KIMI_BLOCK_END, KIMI_HOOK_EVENTS } from './kimi-hooks';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const n = (p: string) => p.replace(/\\/g, '/');
const CONFIG_PATH = path.join('/mock/home', '.kimi-code', 'config.toml');

function mockFiles(rawFiles: Record<string, string>): void {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawFiles)) files[n(k)] = v;
  mockReadFileSync.mockImplementation((p: any) => {
    const content = files[n(String(p))];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  });
}
function written(): string {
  const call = [...mockWriteFileSync.mock.calls].reverse().find(c => n(String(c[0])) === n(CONFIG_PATH));
  expect(call).toBeDefined();
  return String(call![1]);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

const SUPERSET_BLOCK = `# >>> superset-managed-kimi-hooks v1 (do not edit) >>>
[[hooks]]
event = "Stop"
command = '[ -n "$SUPERSET_HOME_DIR" ] && "$SUPERSET_HOME_DIR/hooks/notify.sh" || true'
# <<< superset-managed-kimi-hooks v1 <<<
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('installKimiHooks', () => {
  it('writes a marked [[hooks]] block into a fresh config.toml, one status hook per lifecycle event', () => {
    mockFiles({});
    installKimiHooks();

    expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/mock/home', '.kimi-code'), { recursive: true });
    const out = written();
    expect(count(out, KIMI_BLOCK_BEGIN)).toBe(1);
    expect(count(out, KIMI_BLOCK_END)).toBe(1);
    for (const event of KIMI_HOOK_EVENTS) expect(out).toContain(`event = "${event}"`);
    expect(KIMI_HOOK_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']);
    // A TOML basic string: inner double quotes escaped, single quotes and $ left alone, marker kept for cleanup.
    expect(out).toContain(`command = "sh -c 'echo SessionStart:waiting > \\"$NIGHTYARD_SESSION_ID.status\\"' ${KIMI_HOOK_MARKER}"`);
    expect(out).toContain('command = "sh -c \'echo PermissionRequest:input');
    expect(out).toContain('timeout = 5');
  });

  it('captures the Kimi session id on SessionStart and UserPromptSubmit, and an inspector event for every hook', () => {
    mockFiles({});
    installKimiHooks();
    const out = written();
    expect(count(out, `capture .sessionid ${KIMI_HOOK_MARKER}`)).toBe(2);
    expect(count(out, 'capture-event kimi_event_')).toBe(KIMI_HOOK_EVENTS.length);
  });

  it('keeps foreign config and replaces an older Nightyard block without duplicating it', () => {
    mockFiles({ [CONFIG_PATH]: `default_model = "k3"\n\n${SUPERSET_BLOCK}\n${KIMI_BLOCK_BEGIN}\n[[hooks]]\nevent = "Stop"\ncommand = "old ${KIMI_HOOK_MARKER}"\n${KIMI_BLOCK_END}\n` });
    installKimiHooks();
    const out = written();
    expect(out.startsWith('default_model = "k3"\n')).toBe(true);
    expect(out).toContain(SUPERSET_BLOCK.trim());
    expect(count(out, KIMI_BLOCK_BEGIN)).toBe(1);
    expect(count(out, KIMI_BLOCK_END)).toBe(1);
    expect(out).not.toContain('command = "old');
  });
});

describe('config location', () => {
  it('writes into KIMI_CODE_HOME when Kimi is told to live elsewhere', () => {
    vi.stubEnv('KIMI_CODE_HOME', '/elsewhere/kimi');
    try {
      mockFiles({});
      installKimiHooks();
      const call = mockWriteFileSync.mock.calls.find(c => n(String(c[0])) === '/elsewhere/kimi/config.toml');
      expect(call).toBeDefined();
      expect(mockMkdirSync).toHaveBeenCalledWith('/elsewhere/kimi', { recursive: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('validateKimiHooks', () => {
  it('reports complete when every expected event is inside the Nightyard block', () => {
    mockFiles({});
    installKimiHooks();
    mockFiles({ [CONFIG_PATH]: written() });
    const result = validateKimiHooks();
    expect(result).toMatchObject({ statusLine: 'nightyard', hooks: 'complete' });
    for (const event of KIMI_HOOK_EVENTS) expect(result.hookDetails?.[event]).toBe(true);
  });
  it('reports missing when the config has no Nightyard block, even if other hooks exist', () => {
    mockFiles({ [CONFIG_PATH]: SUPERSET_BLOCK });
    expect(validateKimiHooks().hooks).toBe('missing');
  });
  it('reports partial when the block lacks an event', () => {
    mockFiles({ [CONFIG_PATH]: `${KIMI_BLOCK_BEGIN}\n[[hooks]]\nevent = "SessionStart"\ncommand = "x ${KIMI_HOOK_MARKER}"\n${KIMI_BLOCK_END}\n` });
    const result = validateKimiHooks();
    expect(result.hooks).toBe('partial');
    expect(result.hookDetails?.SessionStart).toBe(true);
    expect(result.hookDetails?.Stop).toBe(false);
  });
});

describe('cleanupKimiHooks', () => {
  it('removes only the Nightyard block and keeps everything else', () => {
    mockFiles({ [CONFIG_PATH]: `default_model = "k3"\n\n${KIMI_BLOCK_BEGIN}\n[[hooks]]\nevent = "Stop"\ncommand = "x ${KIMI_HOOK_MARKER}"\n${KIMI_BLOCK_END}\n\n${SUPERSET_BLOCK}` });
    cleanupKimiHooks();
    const out = written();
    expect(out).not.toContain(KIMI_BLOCK_BEGIN);
    expect(out).not.toContain(KIMI_HOOK_MARKER);
    expect(out).toContain('default_model = "k3"');
    expect(out).toContain(SUPERSET_BLOCK.trim());
  });
  it('writes nothing when there is no Nightyard block or no config at all', () => {
    mockFiles({ [CONFIG_PATH]: 'default_model = "k3"\n' });
    cleanupKimiHooks();
    mockFiles({});
    cleanupKimiHooks();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
