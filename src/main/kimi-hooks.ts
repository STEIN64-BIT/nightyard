import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { STATUS_DIR } from './hook-status';
import { statusCmd as mkStatusCmd, captureSessionIdCmd as mkCaptureSessionIdCmd, installEventScript, wrapPythonHookCmd, installHookScripts } from './hook-commands';
import type { InspectorEventType, SettingsValidationResult } from '../shared/types';

/**
 * Kimi Code CLI reads lifecycle hooks from `~/.kimi-code/config.toml` as
 * `[[hooks]]` array-of-table entries (event / matcher / command / timeout).
 * There is no TOML library in this app, so Nightyard owns exactly one clearly
 * delimited block at the end of the file and leaves every other byte alone —
 * the same convention Superset uses for its own block in that file.
 */
export const KIMI_HOOK_MARKER = '# nightyard-hook';
export const KIMI_BLOCK_BEGIN = '# >>> nightyard-managed-kimi-hooks v1 (do not edit) >>>';
export const KIMI_BLOCK_END = '# <<< nightyard-managed-kimi-hooks v1 <<<';
export const SESSION_ID_VAR = 'NIGHTYARD_SESSION_ID';
export const KIMI_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'] as const;

/** Kimi relocates its whole data dir with KIMI_CODE_HOME; resolve per call so a late env change is honoured. */
function kimiDir(): string {
  return process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code');
}
function configPath(): string {
  return path.join(kimiDir(), 'config.toml');
}
/** Hook commands only write status files; they must never hold up a blockable event. */
const HOOK_TIMEOUT_SECONDS = 5;

const STATUS_BY_EVENT: Record<(typeof KIMI_HOOK_EVENTS)[number], string> = {
  SessionStart: 'waiting',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  PermissionRequest: 'input',
  Stop: 'completed',
  SessionEnd: 'completed',
};

const INSPECTOR_TYPE_BY_EVENT: Record<(typeof KIMI_HOOK_EVENTS)[number], InspectorEventType> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_use',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  SessionEnd: 'stop',
};

function readConfig(): string | null {
  try { return fs.readFileSync(configPath(), 'utf-8'); } catch { return null; }
}

/** TOML basic string: only backslash and double quote need escaping for the commands we emit. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripBlock(content: string): string {
  const begin = content.indexOf(KIMI_BLOCK_BEGIN);
  if (begin < 0) return content;
  const endMarker = content.indexOf(KIMI_BLOCK_END, begin);
  const end = endMarker < 0 ? content.length : endMarker + KIMI_BLOCK_END.length;
  let out = content.slice(0, begin) + content.slice(end);
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function extractBlock(content: string): string | null {
  const begin = content.indexOf(KIMI_BLOCK_BEGIN);
  if (begin < 0) return null;
  const end = content.indexOf(KIMI_BLOCK_END, begin);
  return content.slice(begin, end < 0 ? content.length : end);
}

function hookEntry(event: string, command: string): string {
  return `[[hooks]]\nevent = ${tomlString(event)}\ncommand = ${tomlString(command)}\ntimeout = ${HOOK_TIMEOUT_SECONDS}\n`;
}

function buildBlock(): string {
  const statusCmd = (event: string, status: string) => mkStatusCmd(event, status, SESSION_ID_VAR, KIMI_HOOK_MARKER);
  const captureSessionIdCmd = mkCaptureSessionIdCmd(SESSION_ID_VAR, KIMI_HOOK_MARKER);
  const captureEventCmd = (hookEvent: string, eventType: InspectorEventType) => {
    const pyCode = `import sys,json,os,time
try:
 d=json.load(sys.stdin)
except:
 sys.exit(0)
sid=os.environ.get("${SESSION_ID_VAR}","")
if not sid:
 sys.exit(0)
e={"type":"${eventType}","timestamp":int(time.time()*1000),"hookEvent":"${hookEvent}"}
tn=d.get("tool_name","")
if tn:
 e["tool_name"]=tn
ti=d.get("tool_input")
if ti:
 e["tool_input"]=ti
for fld in ("session_id","cwd"):
 v=d.get(fld,"")
 if v:
  e[fld]=v
status_dir=r'${STATUS_DIR}'
with open(os.path.join(status_dir,sid+".events"),"a") as f:
 f.write(json.dumps(e)+"\\n")
`;
    const scriptName = `kimi_event_${hookEvent}.py`;
    installEventScript(scriptName, pyCode);
    return wrapPythonHookCmd(scriptName, pyCode, KIMI_HOOK_MARKER);
  };

  const entries: string[] = [];
  for (const event of KIMI_HOOK_EVENTS) {
    entries.push(hookEntry(event, statusCmd(event, STATUS_BY_EVENT[event])));
    if (event === 'SessionStart' || event === 'UserPromptSubmit') entries.push(hookEntry(event, captureSessionIdCmd));
    entries.push(hookEntry(event, captureEventCmd(event, INSPECTOR_TYPE_BY_EVENT[event])));
  }
  return `${KIMI_BLOCK_BEGIN}\n${entries.join('\n')}${KIMI_BLOCK_END}\n`;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export function installKimiHooks(): void {
  fs.mkdirSync(kimiDir(), { recursive: true });
  installHookScripts();
  const existing = stripBlock(readConfig() ?? '');
  const head = existing.length === 0 ? '' : existing.endsWith('\n') ? `${existing}\n` : `${existing}\n\n`;
  fs.writeFileSync(configPath(), `${head}${buildBlock()}`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateKimiHooks(): SettingsValidationResult {
  const block = extractBlock(readConfig() ?? '') ?? '';
  const hookDetails: Record<string, boolean> = {};
  let found = 0;
  for (const event of KIMI_HOOK_EVENTS) {
    const installed = block.includes(`event = ${tomlString(event)}`) && block.includes(KIMI_HOOK_MARKER);
    hookDetails[event] = installed;
    if (installed) found++;
  }
  const hooks: SettingsValidationResult['hooks'] = found === KIMI_HOOK_EVENTS.length ? 'complete' : found > 0 ? 'partial' : 'missing';
  return { statusLine: 'nightyard', hooks, hookDetails };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupKimiHooks(): void {
  const content = readConfig();
  if (content === null || !content.includes(KIMI_BLOCK_BEGIN)) return;
  fs.writeFileSync(configPath(), stripBlock(content));
}
