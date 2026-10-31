import { describe, it, expect } from 'vitest';
import type { CounselPreferences, TeamMember } from '../../../shared/types.js';
import {
  buildStartConfig,
  defaultEngineForMember,
  resolveEngineForMember,
  reconcileSeatSuggestions,
  emptyTeamMessage,
  type SeatPick,
} from './start-view.js';

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'member-id',
    name: 'Member',
    role: 'Role',
    systemPrompt: 'You are Member.',
    source: 'custom',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const seatA = makeMember({ id: 'a', name: 'Morgan Prime', role: 'Generalist', systemPrompt: 'System A' });
const seatB = makeMember({ id: 'b', name: 'Codex Morgan', role: 'Coding familiar', systemPrompt: 'System B' });
const seatC = makeMember({ id: 'c', name: 'Skeptic', role: 'Critic', systemPrompt: 'System C' });

function basePicks(): Array<{ member: TeamMember; engine: 'claude' | 'codex' }> {
  return [
    { member: seatA, engine: 'claude' },
    { member: seatB, engine: 'codex' },
    { member: seatC, engine: 'claude' },
  ];
}

describe('buildStartConfig', () => {
  it('maps picks to seats A, B, C in pick order', () => {
    const config = buildStartConfig({
      question: 'Should we ship?',
      picks: basePicks(),
      style: 'balanced',
      contextPass: true,
      projectPath: '/tmp/proj',
      prefs: undefined,
    });

    expect(config.seats.A).toEqual({ memberId: 'a', memberName: 'Morgan Prime', memberRole: 'Generalist', providerId: 'claude' });
    expect(config.seats.B).toEqual({ memberId: 'b', memberName: 'Codex Morgan', memberRole: 'Coding familiar', providerId: 'codex' });
    expect(config.seats.C).toEqual({ memberId: 'c', memberName: 'Skeptic', memberRole: 'Critic', providerId: 'claude' });
  });

  it('fills systemPrompts per seat from each picked member systemPrompt', () => {
    const config = buildStartConfig({
      question: 'Q',
      picks: basePicks(),
      style: 'balanced',
      contextPass: true,
      projectPath: '/tmp/proj',
      prefs: undefined,
    });

    expect(config.systemPrompts).toEqual({ A: 'System A', B: 'System B', C: 'System C' });
  });

  it('passes through question, style, contextPass, projectPath, and a fixed minTurnsBeforeStop', () => {
    const config = buildStartConfig({
      question: '  Should we ship?  ',
      picks: basePicks(),
      style: 'punchy',
      contextPass: false,
      projectPath: '/some/project',
      prefs: undefined,
    });

    expect(config.prompt).toBe('  Should we ship?  ');
    expect(config.style).toBe('punchy');
    expect(config.contextPass).toBe(false);
    expect(config.projectPath).toBe('/some/project');
    expect(config.minTurnsBeforeStop).toBe(3);
  });

  it('defaults maxTurns to 9 and moderatorEnabled to true, and leaves adjudicatorModel unset, when prefs is undefined', () => {
    const config = buildStartConfig({
      question: 'Q',
      picks: basePicks(),
      style: 'balanced',
      contextPass: true,
      projectPath: '/tmp/proj',
      prefs: undefined,
    });

    expect(config.maxTurns).toBe(9);
    expect(config.moderatorEnabled).toBe(true);
    expect(config.adjudicatorModel).toBeUndefined();
  });

  it('applies preference overrides, including adjudicatorModel pass-through', () => {
    const prefs: CounselPreferences = { maxTurns: 5, moderatorEnabled: false, adjudicatorModel: 'opus' };
    const config = buildStartConfig({
      question: 'Q',
      picks: basePicks(),
      style: 'balanced',
      contextPass: true,
      projectPath: '/tmp/proj',
      prefs,
    });

    expect(config.maxTurns).toBe(5);
    expect(config.moderatorEnabled).toBe(false);
    expect(config.adjudicatorModel).toBe('opus');
  });

  it('defaults only the fields the prefs object omits (partial prefs)', () => {
    const prefs: CounselPreferences = { maxTurns: 12 };
    const config = buildStartConfig({
      question: 'Q',
      picks: basePicks(),
      style: 'balanced',
      contextPass: true,
      projectPath: '/tmp/proj',
      prefs,
    });

    expect(config.maxTurns).toBe(12);
    expect(config.moderatorEnabled).toBe(true);
    expect(config.adjudicatorModel).toBeUndefined();
  });
});

describe('defaultEngineForMember', () => {
  it("defaults to the member's counselEngine when set", () => {
    expect(defaultEngineForMember(makeMember({ counselEngine: 'codex' }))).toBe('codex');
  });

  it('falls back to claude when the member has no counselEngine', () => {
    expect(defaultEngineForMember(makeMember({}))).toBe('claude');
  });
});

describe('resolveEngineForMember', () => {
  it("passes through the member's counselEngine when availability is unknown (null)", () => {
    expect(resolveEngineForMember(makeMember({ counselEngine: 'codex' }), null)).toBe('codex');
  });

  it('downgrades codex to claude when checkEngines reported codex unavailable', () => {
    expect(resolveEngineForMember(makeMember({ counselEngine: 'codex' }), { claude: true, codex: false })).toBe('claude');
  });

  it('keeps codex when it is reported available', () => {
    expect(resolveEngineForMember(makeMember({ counselEngine: 'codex' }), { claude: true, codex: true })).toBe('codex');
  });

  it('is unaffected by availability for a member that already prefers claude', () => {
    expect(resolveEngineForMember(makeMember({}), { claude: true, codex: false })).toBe('claude');
  });
});

describe('reconcileSeatSuggestions', () => {
  function seat(overrides: Partial<SeatPick> = {}): SeatPick {
    return { memberId: null, engine: 'claude', touched: false, ...overrides };
  }

  it('excludes members already held by touched seats from the suggestion pool, so untouched seats never duplicate them', () => {
    // "xavier coordinator" scores Xavier far above the other three (0 vs 2),
    // so an unguarded suggestSeats(question, allMembers) call would rank him
    // #1 and hand him to an untouched seat too — even though seat B (touched)
    // already holds him.
    const xavier = makeMember({ id: 'x', name: 'Xavier', role: 'Coordinator' });
    const bea = makeMember({ id: 'bea', name: 'Bea', role: 'Skeptic' });
    const cato = makeMember({ id: 'cato', name: 'Cato', role: 'Strategist' });
    const dana = makeMember({ id: 'dana', name: 'Dana', role: 'Analyst' });
    const members = [xavier, bea, cato, dana];

    const seats: [SeatPick, SeatPick, SeatPick] = [
      seat(), // A: untouched
      seat({ memberId: 'x', touched: true }), // B: touched, holds Xavier
      seat(), // C: untouched
    ];

    const result = reconcileSeatSuggestions('xavier coordinator', members, seats, null);

    expect(result[1]).toEqual(seats[1]); // touched seat B is untouched by reconciliation
    const untouchedIds = [result[0].memberId, result[2].memberId];
    expect(untouchedIds).not.toContain('x');
    expect(new Set(untouchedIds).size).toBe(2); // no duplicate between A and C either
  });

  it('leaves touched seats exactly as-is', () => {
    const members = [seatA, seatB, seatC];
    const seats: [SeatPick, SeatPick, SeatPick] = [
      seat({ memberId: 'a', touched: true, engine: 'codex' }),
      seat({ memberId: 'b', touched: true }),
      seat({ memberId: 'c', touched: true }),
    ];

    const result = reconcileSeatSuggestions('anything', members, seats, null);

    expect(result).toEqual(seats);
  });

  it('leaves an untouched seat unchanged when there are not enough eligible members to fill it', () => {
    const members = [seatA, seatB];
    const seats: [SeatPick, SeatPick, SeatPick] = [
      seat({ memberId: 'a', touched: true }),
      seat({ memberId: 'b', touched: true }),
      seat({ memberId: 'previous-pick' }), // untouched, nothing left in the pool to replace it with
    ];

    const result = reconcileSeatSuggestions('q', members, seats, null);

    expect(result[2]).toEqual(seats[2]);
  });

  it('applies engine availability to newly-assigned seats via resolveEngineForMember', () => {
    const codexMember = makeMember({ id: 'cx', name: 'Codex Pref', counselEngine: 'codex' });
    const members = [codexMember];
    const seats: [SeatPick, SeatPick, SeatPick] = [seat(), seat({ touched: true }), seat({ touched: true })];

    const result = reconcileSeatSuggestions('', members, seats, { claude: true, codex: false });

    expect(result[0].memberId).toBe('cx');
    expect(result[0].engine).toBe('claude'); // downgraded, not 'codex'
  });
});

describe('buildStartConfig seat model', () => {
  it('carries the member counselModel into the seat config, absent otherwise', () => {
    const light: TeamMember = {
      id: 'l', name: 'Morgan Spark', role: 'Instigator', systemPrompt: 'spark', source: 'custom',
      createdAt: 0, updatedAt: 0, counselModel: 'sonnet',
    };
    const plain: TeamMember = {
      id: 'p', name: 'Plain', role: 'r', systemPrompt: 'plain', source: 'custom', createdAt: 0, updatedAt: 0,
    };
    const cfg = buildStartConfig({
      question: 'q',
      picks: [
        { member: light, engine: 'claude' },
        { member: plain, engine: 'claude' },
        { member: { ...plain, id: 'p2', name: 'Plain 2' }, engine: 'claude' },
      ],
      style: 'balanced', contextPass: false, projectPath: '/p', prefs: undefined,
    });
    expect(cfg.seats.A.model).toBe('sonnet');
    expect(cfg.seats.B.model).toBeUndefined();
  });
});

describe('emptyTeamMessage', () => {
  it('tells the user how many more members the counsel needs', () => {
    expect(emptyTeamMessage(0)).toBe('Your counsel needs 3 members — you have 0. Add 3 more from the Team tab.');
    expect(emptyTeamMessage(2)).toBe('Your counsel needs 3 members — you have 2. Add 1 more from the Team tab.');
  });

  it('is empty once three or more members exist (the form takes over)', () => {
    expect(emptyTeamMessage(3)).toBe('');
    expect(emptyTeamMessage(7)).toBe('');
  });
});
