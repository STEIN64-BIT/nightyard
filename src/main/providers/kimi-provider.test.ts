import { vi } from 'vitest';

vi.mock('../pty-manager', () => ({
  getFullPath: vi.fn(() => '/usr/local/bin:/usr/bin'),
}));

vi.mock('./resolve-binary', () => ({
  resolveBinary: vi.fn(() => '/mock/home/.local/bin/kimi'),
  validateBinaryExists: vi.fn(() => true),
}));

vi.mock('../kimi-hooks', () => ({
  installKimiHooks: vi.fn(),
  validateKimiHooks: vi.fn(() => ({ statusLine: 'nightyard', hooks: 'complete', hookDetails: {} })),
  cleanupKimiHooks: vi.fn(),
  SESSION_ID_VAR: 'NIGHTYARD_SESSION_ID',
}));

import { KimiProvider } from './kimi-provider';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { installKimiHooks, validateKimiHooks, cleanupKimiHooks } from '../kimi-hooks';

let provider: KimiProvider;
beforeEach(() => {
  vi.clearAllMocks();
  provider = new KimiProvider();
});

describe('meta', () => {
  it('identifies the Kimi Code CLI with hook-driven status but no config reading or cost tracking', () => {
    expect(provider.meta.id).toBe('kimi');
    expect(provider.meta.displayName).toBe('Kimi Code');
    expect(provider.meta.binaryName).toBe('kimi');
    expect(provider.meta.capabilities).toMatchObject({
      sessionResume: true,
      hookStatus: true,
      configReading: false,
      costTracking: false,
      contextWindow: false,
      shiftEnterNewline: false,
      pendingPromptTrigger: 'first-output',
      planModeArg: '--plan',
      systemPromptInjection: false,
    });
    expect(provider.meta.defaultContextWindowSize).toBe(256_000);
  });
});

describe('binary', () => {
  it('resolves and validates the kimi binary through the shared resolver', () => {
    expect(provider.resolveBinaryPath()).toBe('/mock/home/.local/bin/kimi');
    expect(resolveBinary).toHaveBeenCalledWith('kimi', expect.anything());
    expect(provider.validatePrerequisites()).toBe(true);
    expect(validateBinaryExists).toHaveBeenCalledWith('kimi');
  });
});

describe('buildEnv', () => {
  it('tags the session for the hooks and hands the CLI the full PATH', () => {
    const env = provider.buildEnv('vy-1', { HOME: '/mock/home' });
    expect(env.NIGHTYARD_SESSION_ID).toBe('vy-1');
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.HOME).toBe('/mock/home');
  });
});

describe('buildArgs', () => {
  const base = { cliSessionId: null, isResume: false, extraArgs: '' };
  it('starts a fresh session in ask-when-needed mode by default', () => {
    expect(provider.buildArgs(base)).toEqual(['--yolo']);
  });
  it('resumes a prior Kimi session by id', () => {
    expect(provider.buildArgs({ ...base, cliSessionId: 'abc-123', isResume: true })).toEqual(['--session', 'abc-123', '--yolo']);
  });
  it('passes extra args through, and does not add --yolo when the user chose a permission mode', () => {
    expect(provider.buildArgs({ ...base, extraArgs: '--model k3' })).toEqual(['--model', 'k3', '--yolo']);
    expect(provider.buildArgs({ ...base, extraArgs: '--auto' })).toEqual(['--auto']);
    expect(provider.buildArgs({ ...base, extraArgs: '--plan' })).toEqual(['--plan']);
    expect(provider.buildArgs({ ...base, extraArgs: '-y' })).toEqual(['-y']);
  });
  it('never turns the initial prompt into a flag: Kimi has no interactive prompt argument, so it is typed after first output', () => {
    expect(provider.buildArgs({ ...base, initialPrompt: 'Explain this repo' })).toEqual(['--yolo']);
  });
});

describe('hooks and settings', () => {
  it('delegates hook install, validation and cleanup to kimi-hooks', async () => {
    await provider.installHooks();
    expect(installKimiHooks).toHaveBeenCalledTimes(1);
    expect(provider.validateSettings()).toMatchObject({ hooks: 'complete' });
    expect(validateKimiHooks).toHaveBeenCalledTimes(1);
    provider.reinstallSettings();
    expect(installKimiHooks).toHaveBeenCalledTimes(2);
    provider.cleanup();
    expect(cleanupKimiHooks).toHaveBeenCalledTimes(1);
  });
  it('reports an empty config and no shift-enter sequence', async () => {
    expect(await provider.getConfig('/repo')).toEqual({ mcpServers: [], agents: [], skills: [], commands: [] });
    expect(provider.getShiftEnterSequence()).toBeNull();
  });
});
