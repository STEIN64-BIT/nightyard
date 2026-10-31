'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

function nightyardHome() {
  return process.env.NIGHTYARD_HOME || path.join(os.homedir(), '.nightyard');
}

function statePath() {
  return path.join(nightyardHome(), 'state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeStateAtomic(state) {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp.' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

// macOS-only: returns false on Linux (no Nightyard process by that name) and on Windows (pgrep absent).
function isNightyardRunning() {
  try {
    const out = execSync('pgrep -x Nightyard || true', { encoding: 'utf-8' }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

module.exports = { readState, writeStateAtomic, isNightyardRunning, statePath };
