import type { CliProvider } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { installKimiHooks, validateKimiHooks, cleanupKimiHooks, SESSION_ID_VAR } from '../kimi-hooks';

const binaryCache = { path: null as string | null };

/** Flags that already pick a Kimi permission mode; we only add `--yolo` when none is given. */
const PERMISSION_FLAGS = new Set(['--yolo', '-y', '--auto', '--plan']);

/**
 * Kimi Code CLI (Moonshot AI) as a Nightyard session provider. Status dots and
 * the inspector come from Kimi's lifecycle hooks (see kimi-hooks.ts); MCP /
 * agent / skill listings are not read yet, so the provider-tools widget shows
 * nothing for it. The model itself (K3 or another alias) is whatever
 * `default_model` in ~/.kimi-code/config.toml says, or `--model <alias>` in
 * the session's extra args.
 */
export class KimiProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'kimi',
    displayName: 'Kimi Code',
    binaryName: 'kimi',
    capabilities: {
      sessionResume: true,
      costTracking: false,
      contextWindow: false,
      hookStatus: true,
      configReading: false,
      shiftEnterNewline: false,
      // Kimi has no "start interactive with this prompt" flag (`-p` is non-interactive), so the
      // pending prompt is typed into the TUI once it has drawn.
      pendingPromptTrigger: 'first-output',
      planModeArg: '--plan',
      systemPromptInjection: false,
    },
    defaultContextWindowSize: 256_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('kimi', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('kimi');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>): Record<string, string> {
    const env = { ...baseEnv };
    env[SESSION_ID_VAR] = sessionId;
    env.PATH = getFullPath();
    return env;
  }

  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.isResume && opts.cliSessionId) {
      args.push('--session', opts.cliSessionId);
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs.split(/\s+/).filter(Boolean));
    }
    // Same spirit as Claude's always-on skip-permissions in Nightyard: routine edits and
    // commands just run; risky actions still ask (and surface as "needs you" via hooks).
    if (!args.some((a) => PERMISSION_FLAGS.has(a))) {
      args.push('--yolo');
    }
    return args;
  }

  async installHooks(): Promise<void> {
    installKimiHooks();
  }

  installStatusScripts(): void {}

  cleanup(): void {
    cleanupKimiHooks();
  }

  async getConfig(_projectPath: string): Promise<ProviderConfig> {
    return { mcpServers: [], agents: [], skills: [], commands: [] };
  }

  getShiftEnterSequence(): string | null {
    return null;
  }

  validateSettings(): SettingsValidationResult {
    return validateKimiHooks();
  }

  reinstallSettings(): void {
    installKimiHooks();
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
