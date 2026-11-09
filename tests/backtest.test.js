'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../web/model.js');
const B = require('../tools/backtest.js');

/* A small fake season: 4 pro teams, 1 v 2 and 3 v 4 every day, Monday Oct 20 2025 = day 1. */
const line = (pts) => ['30', '0-0', '0', '0-0', '0', '0-0', '0', '0', '0', '0', '0', '0', '0', String(pts)]; // fantasy points = pts
const gid = (sp, g) => 1000 * sp + g;
const tip = (sp) => Date.UTC(2025, 9, 20 + sp - 1, 23);

function schedRaw(days) {
  const teams = {};
  [1, 2, 3, 4].forEach((i) => { teams[i] = { id: i, abbrev: 'T' + i, location: 'L', name: 'N', proGamesByScoringPeriod: {} }; });
  for (let sp = 1; sp <= days; sp++) {
    [[1, 2, 1], [3, 4, 2]].forEach(([h, a, g]) => [h, a].forEach((t) => {
      teams[t].proGamesByScoringPeriod[sp] = [{ id: gid(sp, g), date: tip(sp), homeProTeamId: h, awayProTeamId: a, scoringPeriodId: sp }];
    }));
  }
  return { settings: { proTeams: Object.values(teams) } };
}
const oppOf = (t) => 'T' + ({ 1: 2, 2: 1, 3: 4, 4: 3 })[t];
const gameRow = (sp, team, pts) => ({ id: String(gid(sp, team <= 2 ? 1 : 2)), team, opp: oppOf(team), home: team % 2 === 1, stats: line(pts) });
const PG = [0, 5, 11, 12, 13], CE = [4, 11, 12, 13];
const pl = (id, team, proj, eligible) => ({ id, name: 'P' + id, first: 'P', last: String(id), team, posId: 1, eligible: eligible || PG, own: 50, proj, projGp: 70 });
const PREV = { home: 1.01, away: 0.99, b2bOutput: 1, b2bPlay: 0.9, opp: { T1: 1, T2: 1, T3: 1, T4: 1 } };

function league(days, nPlayers) {
  const pool = [], logs = [];
  for (let i = 1; i <= nPlayers; i++) {
    const team = (i % 4) + 1, proj = 15 + i;
    pool.push(pl(i, team, proj, i % 5 === 0 ? CE : PG));
    const games = [];
    for (let sp = 1; sp <= days; sp++) if (!(i % 7 === 0 && sp % 3 === 0)) games.push(gameRow(sp, team, proj + ((sp * i) % 11) - 5));
    logs.push(games);
  }
  return B.makeData(2026, schedRaw(days), pool, logs, PREV);
}

test('fantasyPoints uses default ESPN points scoring', () => {
  assert.strictEqual(B.fantasyPoints(['43', '11-19', '57.9', '1-5', '20.0', '5-6', '83.3', '9', '10', '1', '0', '5', '4', '28']), 56);
});

test('below counts values under x', () => {
  assert.deepStrictEqual([0, 3, 4, 6].map((x) => B.below([1, 3, 5], x)), [0, 1, 2, 3]);
});

test('playerAt knows nothing from that day onwards and matches the app formula', () => {
  const d = B.makeData(2026, schedRaw(14), [pl(1, 1, 30)], [[gameRow(1, 1, 10), gameRow(3, 1, 20), gameRow(5, 1, 30)]], PREV);
  const at3 = B.playerAt(d, 1, 3), at6 = B.playerAt(d, 1, 6);
  const cur = (p) => p.stats.find((s) => s.id === '002026');
  assert.strictEqual(cur(at3).stats[42], 1);
  assert.strictEqual(cur(at3).appliedAverage, 10);
  assert.strictEqual(cur(at6).appliedAverage, 20);
  assert.strictEqual(cur(B.playerAt(d, 1, 1)), undefined);
  assert.ok(Math.abs(M.projectPlayer(at6, 2026, true).fp - ((3 / 13) * 20 + (10 / 13) * 30)) < 1e-9);
  assert.strictEqual(M.gameStat(B.playerAt(d, 1, 6, { gamesFrom: 3 }), 3).appliedTotal, 20);
  assert.strictEqual(M.gameStat(B.playerAt(d, 1, 6, { gamesFrom: 3 }), 1), null);
});

test('a player is out only after missing his last two team games', () => {
  const d = B.makeData(2026, schedRaw(14), [pl(1, 1, 30)], [[gameRow(1, 1, 10), gameRow(2, 1, 10), gameRow(6, 1, 10)]], PREV);
  assert.strictEqual(B.playerAt(d, 1, 3).injury, 'ACTIVE');
  assert.strictEqual(B.playerAt(d, 1, 4).injury, 'ACTIVE'); // one miss
  assert.strictEqual(B.playerAt(d, 1, 5).injury, 'OUT');
  assert.strictEqual(B.playerAt(d, 1, 7).injury, 'ACTIVE'); // played yesterday
});

test('factorsAt uses only earlier weeks and blends towards them', () => {
  const games = (extra) => {
    const a = [];
    for (let sp = 1; sp <= 7; sp++) a.push(gameRow(sp, 1, 30));
    for (let sp = 8; sp <= 10; sp++) a.push(gameRow(sp, 1, extra));
    return a;
  };
  const build = (extra) => B.makeData(2026, schedRaw(21), [pl(1, 1, 30), pl(2, 3, 30)], [games(extra), [1, 2, 3, 4, 5, 6, 7].map((sp) => gameRow(sp, 3, 15))], PREV);
  const one = B.factorsAt(build(30), 9).opp, other = B.factorsAt(build(90), 9).opp;
  assert.deepStrictEqual(one, other, 'the week being predicted must not leak in');
  assert.ok(Math.abs(one.T2 - 1) < 1e-9); // he scored his own average against T2, so T2 stays at last season's 1
  const d = build(30);
  assert.strictEqual(B.factorsAt(d, 3).opp.T2, 1, 'no games yet, last season stands');
  assert.strictEqual(d.factorCache.size, 1);
});

test('measureSeason finds home, away and back-to-back effects', () => {
  const raw = schedRaw(60);
  const log = [];
  for (let sp = 1; sp <= 60; sp++) log.push(Object.assign(gameRow(sp, 1, sp % 2 ? 30 : 30), { home: sp % 2 === 1, stats: line(sp % 2 ? 36 : 24) }));
  const f = B.measureSeason(raw, [log]);
  assert.ok(f.home > 1.1 && f.away < 0.9);
  assert.ok(f.b2bPlay > 0.5 && f.b2bPlay <= 1.0001);
});

test('draft gives everyone a full unique roster and caps pure centers', () => {
  const d = league(14, 60);
  const r = B.draft(d, 4, 5, B.mulberry32(3));
  const ids = r.flat();
  assert.strictEqual(new Set(ids).size, 20);
  r.forEach((x) => {
    assert.strictEqual(x.length, 5);
    assert.ok(x.filter((id) => d.players.get(id).eligible.indexOf(0) < 0).length <= 3);
  });
  assert.deepStrictEqual(B.draft(d, 4, 5, B.mulberry32(3)), r);
  assert.throws(() => B.draft(d, 4, 40, B.mulberry32(3)), /Not enough/);
});

test('roundRobin plays everyone once a week and meets each opponent once per cycle', () => {
  const s = B.roundRobin(6, 5);
  s.forEach((week) => assert.deepStrictEqual(week.flat().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]));
  const seen = new Set(s.flat().map(([a, b]) => Math.min(a, b) + '-' + Math.max(a, b)));
  assert.strictEqual(seen.size, 15);
});

test('calibrate compares predictions with results', () => {
  const c = B.calibrate([{ p: 0.75, won: 1 }, { p: 0.75, won: 1 }, { p: 0.75, won: 1 }, { p: 0.75, won: 0 }, { p: 1, won: 1 }]);
  assert.strictEqual(c.n, 5);
  assert.ok(Math.abs(c.brier - ((3 * 0.0625 + 0.5625) / 5)) < 1e-9);
  assert.strictEqual(c.gap, 0);
  assert.strictEqual(c.bins[9].n, 1);
  assert.strictEqual(B.calibrate([]).brier, null);
});

test('testProjections runs the app formula and testWindows compares schedules', () => {
  const d = league(70, 24);
  const r = B.testProjections(d);
  assert.ok(r.games > 1000);
  assert.ok(r.recipes['ESPN worth 10 games (the app)'].n === r.games);
  assert.ok(r.adjust['Plus this season\'s defenses (the app)'].n === r.games);
  const w = B.testWindows(d, 1);
  assert.ok(w.flat.n > 0 && w.flat.n === w.real.n);
  assert.ok(w.pairs.n > 0);
});

test('runLeague plays a full simulated season, deterministically', () => {
  const run = () => B.runLeague(league(21, 40), { teams: 4, seed: 2, caps: { 0: 1, 11: 1 }, bench: 1, sims: 50, policies: ['spend', 'this-week'] });
  const r = run();
  assert.strictEqual(r.calibration.length, 3 * 2 * 3); // 3 weeks, 2 matchups, 3 checkpoints
  r.calibration.forEach((c) => assert.ok(c.p >= 0 && c.p <= 1));
  assert.strictEqual(r.results.length, 4);
  r.results.forEach((x) => {
    assert.strictEqual(x.none.adds, 0);
    assert.strictEqual(x.none.weeks, 3);
    assert.ok(x.spend.adds >= 0);
  });
  const s = B.summarizePolicies(r.results, ['spend', 'this-week']);
  assert.ok(Math.abs(s.none.win - 0.5) < 1e-9, 'every game has one winner');
  assert.strictEqual(s.none.dPts.m, 0);
  assert.deepStrictEqual(run().results, r.results);
});

test('parseArgs reads the options and rejects bad ones', () => {
  assert.deepStrictEqual(B.parseArgs(['--seasons', '2025', '--teams', '12', '--leagues', '5']).seasons, [2025]);
  assert.strictEqual(B.parseArgs(['--quick']).leagues, 1);
  assert.throws(() => B.parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => B.parseArgs(['--teams', '11']), /even/);
});
