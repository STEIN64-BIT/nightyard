import { RealClaudeLauncher, type RealClaudeLauncherOptions } from './claude-launcher.js';
import { CodexLauncher, DuoLauncher } from './duo-launcher.js';
import type { ClaudeLauncher } from './launcher.js';
import { brand } from '../ui/colors.js';

export type SleepyProvider = 'opus' | 'codex' | 'duo';

export function resolveSleepyProvider(opts: { provider?: string; team?: boolean }): SleepyProvider {
  if (opts.team && opts.provider !== undefined) {
    throw new Error('Choose --provider opus, --provider codex, or --team; --team cannot be combined with --provider.');
  }
  if (opts.team) return 'duo';
  if (opts.provider !== undefined && opts.provider !== 'opus' && opts.provider !== 'codex') {
    throw new Error(`Invalid --provider "${opts.provider}" (expected opus|codex). Use --team for Codex + Opus.`);
  }
  return opts.provider ?? 'opus';
}

interface LauncherFactories {
  opus: (options: RealClaudeLauncherOptions) => ClaudeLauncher;
  codex: () => ClaudeLauncher;
}
const defaults: LauncherFactories = {
  opus: options => new RealClaudeLauncher(options),
  codex: () => new CodexLauncher(),
};

/** Every role is selected here so a single-provider run cannot hide another provider call. */
export function createRunLaunchers(provider: SleepyProvider, stopFile: string, factories: LauncherFactories = defaults) {
  if (provider === 'codex') {
    const orchestrator = factories.codex();
    const worker = factories.codex();
    return { orchestrator, worker, artifact: worker };
  }
  // Headless hosts cannot inherit the desktop's interactive tool approvals.
  const headlessArgs = process.env.SLEEPY_HEADLESS === '1'
    ? ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash']
    : [];
  const orchestrator = factories.opus({
    streamOutput: true, streamPrefix: brand.orchestrator('  │ '), extraArgs: ['--model', 'opus', ...headlessArgs],
  });
  const artifact = factories.opus({
    streamOutput: true, streamPrefix: brand.worker('  ▸ '), extraArgs: ['--model', 'opus', ...headlessArgs],
  });
  const worker = provider === 'duo'
    ? new DuoLauncher(factories.codex(), factories.opus({
      timeoutMs: 20 * 60 * 1000,
      extraArgs: ['--model', 'opus', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    }), stopFile)
    : artifact;
  return { orchestrator, worker, artifact };
}
