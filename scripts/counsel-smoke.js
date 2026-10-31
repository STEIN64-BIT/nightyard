// Runs a real 1-round, 3-persona debate in the terminal against the live CLIs.
// Usage: npm run build && node scripts/counsel-smoke.js "your question"
const { launchCounsel } = require('../dist/main/main/counsel/orchestrator');
const { createCliRunner } = require('../dist/main/main/counsel/runner');

const prompt = process.argv[2] || 'Tabs or spaces?';
const seat = (id, name, role, providerId) => ({ memberId: id, memberName: name, memberRole: role, providerId });

const handle = launchCounsel(
  {
    counselId: 'smoke',
    projectPath: process.cwd(),
    prompt,
    seats: {
      A: seat('1', 'Morgan Prime', 'Butler', 'claude'),
      B: seat('2', 'Staff Engineer', 'Engineer', 'claude'),
      C: seat('3', 'Morgan Codex', 'Coding familiar', 'codex'),
    },
    systemPrompts: {
      A: 'You are Morgan Prime, a dry, capable butler-style assistant. Occasionally witty.',
      B: 'You are a pragmatic staff engineer. Blunt, technical, allergic to overengineering.',
      C: 'You are Morgan Codex, a sharp coding familiar. Terse and precise.',
    },
    style: 'balanced',
    contextPass: false,
    maxTurns: 3,
    minTurnsBeforeStop: 3,
    moderatorEnabled: false,
  },
  {
    runner: createCliRunner(),
    emit: (e) => {
      if (e.type === 'turn-start') process.stdout.write(`\n\n--- ${e.seat} (round ${e.round}) ---\n`);
      else if (e.type === 'turn-delta') process.stdout.write(e.chunk);
      else if (e.type === 'verdict') console.log('\n\nVERDICT:', JSON.stringify(e.verdict, null, 2));
      else if (e.type === 'error') console.error('\nERROR:', e.message);
    },
  },
);
handle.result.then(() => process.exit(0));
