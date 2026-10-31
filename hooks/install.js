#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Marks the optional helper hooks this repo installs. Deliberately distinct
// from Nightyard's own `# nightyard-hook` marker so neither strips the other.
const MARKER = '# nightyard-extra-hook';
// Older installs of these same hooks used this marker; still recognised so
// re-installing or uninstalling cleans them up.
const LEGACY_MARKERS = ['# stein-hook'];
const HOOKS_DIR = path.resolve(__dirname);
const PYTHON = '/usr/bin/python3';

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeSettings(settings) {
  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp.' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

function isExtraHook(handler) {
  return typeof handler.command === 'string' &&
    [MARKER, ...LEGACY_MARKERS].some((m) => handler.command.includes(m));
}

function stripExtraHooks(hooks) {
  const out = {};
  for (const [event, matchers] of Object.entries(hooks || {})) {
    const filteredMatchers = matchers
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isExtraHook(h)) }))
      .filter((m) => m.hooks.length > 0);
    if (filteredMatchers.length > 0) out[event] = filteredMatchers;
  }
  return out;
}

function buildCommand(scriptName) {
  const abs = path.join(HOOKS_DIR, scriptName);
  return `${PYTHON} ${abs} ${MARKER}`;
}

function addHook(hooks, event, command) {
  if (!hooks[event]) hooks[event] = [];
  // Find a matcher with empty pattern, or create one
  let entry = hooks[event].find((m) => m.matcher === '');
  if (!entry) {
    entry = { matcher: '', hooks: [] };
    hooks[event].push(entry);
  }
  entry.hooks.push({ type: 'command', command });
  return hooks;
}

function main() {
  const settings = readSettings();
  let hooks = stripExtraHooks(settings.hooks || {});

  hooks = addHook(hooks, 'UserPromptSubmit', buildCommand('clock.py'));
  hooks = addHook(hooks, 'SessionStart', buildCommand('clock.py'));
  hooks = addHook(hooks, 'SessionStart', buildCommand('memory_bootstrap.py'));

  settings.hooks = hooks;
  writeSettings(settings);
  console.log('Installed extra hooks: clock.py, memory_bootstrap.py');
}

main();
