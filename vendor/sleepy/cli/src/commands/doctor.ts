import { Command } from 'commander';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface DoctorEnv {
  nodeVersion: string;
  claudePath: string | null;
  gitPath: string | null;
  pluginDirExists: boolean;
  pluginDirWritable: boolean;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

function parseMajor(version: string): number {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

export function runDoctor(env: DoctorEnv): DoctorReport {
  const checks: CheckResult[] = [];

  const major = parseMajor(env.nodeVersion);
  checks.push(
    major >= 20
      ? { name: 'node', status: 'pass', detail: env.nodeVersion }
      : { name: 'node', status: 'fail', detail: `need Node 20+, have ${env.nodeVersion}` },
  );

  checks.push(
    env.claudePath
      ? { name: 'claude', status: 'pass', detail: env.claudePath }
      : { name: 'claude', status: 'fail', detail: 'claude CLI not found in PATH' },
  );

  checks.push(
    env.gitPath
      ? { name: 'git', status: 'pass', detail: env.gitPath }
      : { name: 'git', status: 'fail', detail: 'git not found in PATH' },
  );

  if (!env.pluginDirExists) {
    checks.push({
      name: 'plugin',
      status: 'warn',
      detail: 'plugin not installed yet (run install.sh)',
    });
  } else if (!env.pluginDirWritable) {
    checks.push({
      name: 'plugin',
      status: 'fail',
      detail: 'plugin directory exists but is not writable',
    });
  } else {
    checks.push({ name: 'plugin', status: 'pass', detail: 'installed and writable' });
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checks };
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('which', [cmd]);
    const line = stdout.trim().split('\n')[0];
    return line || null;
  } catch {
    return null;
  }
}

async function readEnv(): Promise<DoctorEnv> {
  const pluginDir = path.join(os.homedir(), '.claude', 'plugins', 'sleepy');
  let pluginDirExists = false;
  let pluginDirWritable = false;
  try {
    await access(pluginDir, constants.F_OK);
    pluginDirExists = true;
    try {
      await access(pluginDir, constants.W_OK);
      pluginDirWritable = true;
    } catch {
      // not writable
    }
  } catch {
    // doesn't exist
  }

  return {
    nodeVersion: process.version,
    claudePath: await which('claude'),
    gitPath: await which('git'),
    pluginDirExists,
    pluginDirWritable,
  };
}

function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  const symbol = (s: CheckStatus) => (s === 'pass' ? '✓' : s === 'warn' ? '⚠' : '✗');
  for (const c of report.checks) {
    lines.push(`  ${symbol(c.status)} ${c.name.padEnd(8)} ${c.detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'sleepy doctor: OK' : 'sleepy doctor: problems found');
  return lines.join('\n');
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('run environment diagnostics')
    .action(async () => {
      const env = await readEnv();
      const report = runDoctor(env);
      console.log(formatReport(report));
      if (!report.ok) process.exit(1);
    });
}
