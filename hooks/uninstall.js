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

function main() {
  const settings = readSettings();
  settings.hooks = stripExtraHooks(settings.hooks || {});
  writeSettings(settings);
  console.log('Removed extra hooks');
}

main();
