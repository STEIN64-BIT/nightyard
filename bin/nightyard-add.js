#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readState, writeStateAtomic, isNightyardRunning } = require('../hooks/lib/state.js');

function parseArgs(argv) {
  const out = { positional: [], name: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') {
      out.name = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      out.help = true;
    } else {
      out.positional.push(argv[i]);
    }
  }
  return out;
}

function uuid() {
  return crypto.randomUUID();
}

function defaultBoard() {
  return {
    columns: [
      { id: uuid(), title: 'Backlog', order: 0, behavior: 'inbox' },
      { id: uuid(), title: 'Ready',   order: 1, behavior: 'none' },
      { id: uuid(), title: 'Running', order: 2, behavior: 'active' },
      { id: uuid(), title: 'Done',    order: 3, behavior: 'terminal' },
    ],
    tasks: [],
  };
}

function help() {
  console.log('Usage: nightyard-add <path> [--name X]');
  console.log('Adds a project to ~/.nightyard/state.json. Skip-perms comes from the globalDefaultArgs preference.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length === 0) {
    help();
    process.exit(args.help ? 0 : 1);
  }

  const projectPath = path.resolve(args.positional[0]);
  if (!fs.existsSync(projectPath)) {
    console.error(`error: path does not exist: ${projectPath}`);
    process.exit(1);
  }

  if (isNightyardRunning()) {
    console.error('error: Nightyard is currently running. Quit it before running nightyard-add.');
    process.exit(2);
  }

  const state = readState() || { version: 1, projects: [], activeProjectId: null, preferences: {} };

  if (state.projects.some((p) => p.path === projectPath)) {
    console.error(`error: project at ${projectPath} is already in state`);
    process.exit(3);
  }

  const project = {
    id: uuid(),
    name: args.name || path.basename(projectPath),
    path: projectPath,
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
    board: defaultBoard(),
    insights: { initialContextSnapshots: [], dismissed: [] },
  };

  state.projects.push(project);
  if (!state.activeProjectId) state.activeProjectId = project.id;
  writeStateAtomic(state);

  console.log(`Added project '${project.name}' (${project.id}) at ${projectPath}`);
}

main();
