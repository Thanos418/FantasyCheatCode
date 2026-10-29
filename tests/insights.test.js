'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../web/model.js');
const I = require('../web/insights.js');
const FACT = require('../web/factors.js');

/* ------------------------------------------------------------ fixtures */

const SEASON = 2027;
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol), a + ' !~ ' + b);
const tip = (sp) => Date.UTC(2026, 9, 20 + sp - 1, 23);

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// pro teams 1..n and a list of games {id, sp, home, away}
function proRaw(n, games) {
  const teams = {};
  for (let i = 1; i <= n; i++) teams[i] = { id: i, abbrev: 'T' + i, location: 'Town' + i, name: 'Nick' + i, proGamesByScoringPeriod: {} };
  games.forEach((g) => {
    [g.home, g.away].forEach((t) => {
      (teams[t].proGamesByScoringPeriod[g.sp] = teams[t].proGamesByScoringPeriod[g.sp] || []).push({
        id: g.id, date: tip(g.sp), homeProTeamId: g.home, awayProTeamId: g.away, scoringPeriodId: g.sp, startTimeTBD: false,
      });
    });
  });
  return { settings: { proTeams: [{ id: 0, abbrev: 'FA', proGamesByScoringPeriod: {} }].concat(Object.values(teams)) } };
}
// 1v2 and 3v4 every day
function everyDay(days) {
  const g = [];
  for (let sp = 1; sp <= days; sp++) { g.push({ id: sp * 10 + 1, sp, home: 1, away: 2 }); g.push({ id: sp * 10 + 2, sp, home: 3, away: 4 }); }
  return g;
}
// 1v2 every day, 3v4 on even days
function halfDay(days) {
  const g = [];
  for (let sp = 1; sp <= days; sp++) { g.push({ id: sp * 10 + 1, sp, home: 1, away: 2 }); if (sp % 2 === 0) g.push({ id: sp * 10 + 2, sp, home: 3, away: 4 }); }
  return g;
}
const schedOf = (n, games) => M.buildProSchedule(proRaw(n, games));

function mkLeague(o) {
  o = o || {};
  return M.normLeague({
    id: 1, seasonId: SEASON,
    settings: {
      name: 'T', size: (o.teams || []).length || 4,
      scoringSettings: { scoringType: o.cat ? 'H2H_CATEGORY' : 'H2H_POINTS' },
      rosterSettings: { lineupSlotCounts: o.slots || { 0: 1, 4: 1, 11: 2, 12: 3, 13: 1 } },
      acquisitionSettings: { matchupAcquisitionLimit: 1, matchupLimitPerScoringPeriod: true },
      scheduleSettings: { matchupPeriodCount: o.regular || 19, matchupPeriods: {} },
    },
    status: { latestScoringPeriod: o.cur || 1, currentMatchupPeriod: o.mp || 1, finalScoringPeriod: o.finalSp || 174 },
    teams: o.teams || [],
    schedule: o.schedule || [],
  });
}

const PG = [0, 5, 11, 12, 13];
const CE = [4, 9, 11, 12, 13];
const POSES = [[0, 5, 11, 12, 13], [1, 5, 11, 12, 13], [2, 6, 11, 12, 13], [3, 6, 11, 12, 13], [4, 11, 12, 13], [0, 1, 5, 11, 12, 13], [2, 3, 6, 11, 12, 13], [3, 4, 6, 11, 12, 13]];

function stat(id, o) { return Object.assign({ id, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 0, appliedAverage: 0, stats: {} }, o); }
// prefix: '00' season, '01' last 7, '02' last 15, '10' ESPN projection. min/gs are totals.
function entry(prefix, avg, gp, min, gs) {
  const s = {};
  if (gp != null) s[42] = gp;
  if (min != null) s[40] = min;
  if (gs != null) s[41] = gs;
  return stat(prefix + SEASON, { statSourceId: prefix[0] === '1' ? 1 : 0, appliedAverage: avg, appliedTotal: avg * (gp || 0), stats: s });
}

function mk(id, o) {
  o = o || {};
  const stats = [];
  if (o.proj != null) stats.push(entry('10', o.proj, 70));
  (o.stats || []).forEach((s) => stats.push(s));
  const raw = {
    id, fullName: o.name || ('Player ' + id), firstName: 'P', lastName: String(id), proTeamId: o.team != null ? o.team : 1,
    defaultPositionId: 1, eligibleSlots: o.elig || PG, injuryStatus: o.injury || 'ACTIVE',
    ownership: { percentOwned: 10, percentChange: 0 }, stats,
  };
  const p = M.normPlayer({ playerId: id, lineupSlotId: o.slot != null ? o.slot : null, injuryStatus: o.injury || 'ACTIVE', playerPoolEntry: { player: raw } });
  if (o.onTeamId != null) p.onTeamId = o.onTeamId;
  return p;
}

/* ------------------------------------------------- winProbability etc. */

const cellP = (fp, extra) => Object.assign({ t: 'proj', fp, opp: 'T2', home: true, b2b: false, start: true, out: false, dtd: false, tip: 0 }, extra);
const teamOf = (actual, cells) => ({ actual, rows: cells.map((c, i) => ({ player: { id: i }, cells: { [10 + i]: c } })) });
const rep = (n, f) => Array.from({ length: n }, f);

test('winProbability: deterministic for a seed and different for another', () => {
  const vm = { me: teamOf(300, rep(8, () => cellP(30))), opp: teamOf(320, rep(8, () => cellP(28))) };
  const a = I.winProbability(vm, { seed: 7 }), b = I.winProbability(vm, { seed: 7 });
  assert.deepStrictEqual(a, b);
  const c = I.winProbability(vm, { seed: 8 });
  assert.notDeepStrictEqual(a, c);
  assert.ok(a.pWin > 0 && a.pWin < 1);
  assert.ok(a.me.sd > 0 && a.opp.sd > 0);
  // default seed is stable too
  assert.deepStrictEqual(I.winProbability(vm), I.winProbability(vm, { seed: 1 }));
});

test('winProbability: a team far ahead with nothing left is certain, level teams tie', () => {
  let wp = I.winProbability({ me: teamOf(800, []), opp: teamOf(400, []) });
  assert.strictEqual(wp.pWin, 1);
  assert.strictEqual(wp.pTie, 0);
  assert.deepStrictEqual(wp.me, { mean: 800, sd: 0 });
  assert.deepStrictEqual(wp.opp, { mean: 400, sd: 0 });
  wp = I.winProbability({ me: teamOf(400, []), opp: teamOf(800, []) });
  assert.strictEqual(wp.pWin, 0);
  wp = I.winProbability({ me: teamOf(500, []), opp: teamOf(500, []) });
  assert.strictEqual(wp.pTie, 1);
  assert.strictEqual(wp.pWin, 0.5);
  // far ahead with a little left is still ~1
  wp = I.winProbability({ me: teamOf(800, rep(2, () => cellP(30))), opp: teamOf(400, rep(4, () => cellP(40))) });
  assert.ok(wp.pWin > 0.999); // the opponent needs 400 more but has about 160 left
});

test('winProbability: symmetric teams are about 50-50', () => {
  const cells = () => rep(12, () => cellP(30));
  const wp = I.winProbability({ me: teamOf(300, cells()), opp: teamOf(300, cells()) }, { sims: 8000 });
  assert.ok(Math.abs(wp.pWin - 0.5) < 0.03, String(wp.pWin));
  assert.ok(wp.pTie < 0.001);
  near(wp.me.mean, 300 + 12 * 30, 6);
  near(wp.opp.mean, 300 + 12 * 30, 6);
  // sd of a sum of 12 independent N(30, 10.5) games
  near(wp.me.sd, Math.sqrt(12) * 30 * 0.35, 2);
  // a stronger team wins more often, a bigger cv widens the spread
  const strong = I.winProbability({ me: teamOf(300, rep(12, () => cellP(40))), opp: teamOf(300, cells()) });
  assert.ok(strong.pWin > 0.9);
  const wide = I.winProbability({ me: teamOf(300, cells()), opp: teamOf(300, cells()) }, { cv: 0.8 });
  assert.ok(wide.me.sd > wp.me.sd * 1.8); // 0.8 vs 0.35, trimmed a little because games cannot go below zero
});

test('winProbability: a bye gives no win chance and no opponent', () => {
  const wp = I.winProbability({ me: teamOf(200, rep(5, () => cellP(40))), opp: null });
  assert.strictEqual(wp.pWin, null);
  assert.strictEqual(wp.pTie, null);
  assert.strictEqual(wp.opp, null);
  near(wp.me.mean, 400, 4);
  assert.ok(wp.me.sd > 0);
  assert.strictEqual(I.winDelta(wp, 10), null);
});

test('winProbability: out, non-start and non-projected cells are ignored', () => {
  const me = {
    actual: 100,
    rows: [
      { player: { id: 1 }, cells: { 10: cellP(50, { start: false }), 11: cellP(50, { out: true, start: false }), 12: cellP(50, { out: true }) } },
      { player: { id: 2 }, cells: { 7: { t: 'played', fp: 40, counted: true, why: null }, 8: { t: 'dnp', why: 'dnp' } } },
    ],
  };
  const wp = I.winProbability({ me, opp: teamOf(0, []) });
  assert.deepStrictEqual(wp.me, { mean: 100, sd: 0 });
});

test('winProbability: day-to-day lowers the mean, back-to-back keeps cell.fp but adds variance', () => {
  const base = I.winProbability({ me: teamOf(0, rep(10, () => cellP(40))), opp: teamOf(0, []) }, { sims: 20000 });
  near(base.me.mean, 400, 4);
  const dtd = I.winProbability({ me: teamOf(0, rep(10, () => cellP(40, { dtd: true }))), opp: teamOf(0, []) }, { sims: 20000 });
  assert.ok(dtd.me.mean < base.me.mean * 0.8);
  near(dtd.me.mean, 300, 5);
  const half = I.winProbability({ me: teamOf(0, rep(10, () => cellP(40, { dtd: true }))), opp: teamOf(0, []) }, { sims: 20000, dtdPlay: 0.5 });
  near(half.me.mean, 200, 4);
  assert.ok(dtd.me.sd > base.me.sd);

  // cell.fp of a b2b game already includes the chance of playing: fp 80 = 100 x 0.8
  const fac = { b2bPlay: 0.8 };
  const b2bCells = () => rep(10, () => cellP(80, { b2b: true }));
  const b2b = I.winProbability({ me: teamOf(0, b2bCells()), opp: teamOf(0, []) }, { sims: 20000, factors: fac });
  near(b2b.me.mean, 800, 8); // not inflated to 1000
  const plain = I.winProbability({ me: teamOf(0, rep(10, () => cellP(80))), opp: teamOf(0, []) }, { sims: 20000, factors: fac });
  near(plain.me.mean, 800, 8);
  assert.ok(b2b.me.sd > plain.me.sd * 1.4); // same mean, riskier
  // without factors a b2b flag changes nothing
  const noFac = I.winProbability({ me: teamOf(0, b2bCells()), opp: teamOf(0, []) }, { sims: 20000 });
  near(noFac.me.mean, 800, 8);
  assert.ok(Math.abs(noFac.me.sd - plain.me.sd) < 3);
});

test('winDelta: sign, size and the zero-spread guard', () => {
  const wp = { pWin: 0.5, pTie: 0, me: { mean: 100, sd: 10 }, opp: { mean: 100, sd: 10 } };
  const s = Math.sqrt(200);
  near(I.winDelta(wp, s), 0.3413447, 1e-4); // Phi(1) - Phi(0)
  assert.ok(I.winDelta(wp, 5) > 0);
  assert.ok(I.winDelta(wp, -5) < 0);
  assert.strictEqual(I.winDelta(wp, 0), 0);
  near(I.winDelta(wp, 5), -I.winDelta(wp, -5), 1e-6); // symmetric around level
  // adding to a lead has diminishing returns
  const ahead = { me: { mean: 130, sd: 10 }, opp: { mean: 100, sd: 10 } };
  assert.ok(I.winDelta(ahead, 10) < I.winDelta(wp, 10));
  // no spread: a deterministic result flips or it does not
  const flat = { me: { mean: 99, sd: 0 }, opp: { mean: 100, sd: 0 } };
  assert.strictEqual(I.winDelta(flat, 5), 1);
  assert.strictEqual(I.winDelta(flat, 0.5), 0);
  assert.strictEqual(I.winDelta({ me: { mean: 100, sd: 0 }, opp: { mean: 100, sd: 0 } }, 5), 0.5);
  assert.strictEqual(I.winDelta({ me: { mean: 1, sd: 0 }, opp: null }, 5), null);
  assert.strictEqual(I.winDelta({ pWin: null, me: { mean: 1, sd: 0 }, opp: null }, 5), null);
});

/* a real WeekVM from computeWeek */

function buildVm(withFactors) {
  const sched = schedOf(4, everyDay(14));
  const league = mkLeague({
    cur: 6, mp: 2, teams: [{ id: 6, name: 'Me', abbrev: 'ME' }, { id: 4, name: 'Opp', abbrev: 'OPP' }],
    schedule: [{ matchupPeriodId: 2, home: { teamId: 6, totalPoints: 0 }, away: { teamId: 4, totalPoints: 0 } }],
  });
  const week = { id: 2, sps: [7, 8, 9, 10, 11, 12, 13], first: 7, last: 13, playoff: false, long: false, calWeeks: [2], label: 'Week 2', range: 'Oct 26 – Nov 1' };
  const mine = [mk(1, { team: 1, proj: 30, slot: 0, elig: PG }), mk(2, { team: 2, proj: 25, slot: 4, elig: CE }), mk(3, { team: 3, proj: 20, slot: 11, elig: PG }), mk(4, { team: 4, proj: 15, slot: 11, elig: CE })];
  const theirs = [mk(11, { team: 1, proj: 22, slot: 0, elig: PG }), mk(12, { team: 2, proj: 18, slot: 4, elig: CE }), mk(13, { team: 3, proj: 14, slot: 11, elig: PG }), mk(14, { team: 4, proj: 10, slot: 11, elig: CE })];
  const ctx = {
    league, sched, week, now: tip(7) - 3 * 3600 * 1000, myTeamId: 6,
    rosters: { 6: { current: mine, bySp: {} }, 4: { current: theirs, bySp: {} } },
    freeAgents: [], transactions: [], factors: withFactors ? FACT : null,
  };
  return M.computeWeek(ctx);
}

test('winProbability on a real week view model: mean matches the projection', () => {
  const vm = buildVm(false);
  assert.strictEqual(vm.me.projFinal, 7 * 90);
  const wp = I.winProbability(vm, { factors: null });
  near(wp.me.mean, vm.me.projFinal, 0.01 * vm.me.projFinal);
  near(wp.opp.mean, vm.opp.projFinal, 0.01 * vm.opp.projFinal);
  assert.ok(wp.pWin > 0.9);
  // with game factors every cell after day one is a back-to-back; cell.fp already carries the play chance
  const vf = buildVm(true);
  assert.ok(vf.me.rows.some((r) => Object.values(r.cells).some((c) => c.b2b)));
  const wf = I.winProbability(vf, { factors: FACT, sims: 20000 });
  near(wf.me.mean, vf.me.projFinal, 0.01 * vf.me.projFinal);
  near(wf.opp.mean, vf.opp.projFinal, 0.01 * vf.opp.projFinal);
  assert.ok(wf.pWin > 0.8);
});

/* ------------------------------------------------------ playoffPlanner */

/*
 Pro teams 1-4. Playoff round 1 = sps 21-27, round 2 = sps 28-30. Games:
  21: 1v2 3v4   22: 1v3   23: 2v4   24: 1v4   25: 1v2   26: -   27: 3v4   28: 2v3   29: 1v4   30: -
 games (round 1 / round 2): T1 4/1, T2 3/1, T3 3/1, T4 4/1.
 back-to-backs (second nights): T1 sp22, sp25; T3 sp22, sp28 (across the round break); T4 sp24; T2 none.
*/
const PO_GAMES = [
  { id: 1, sp: 21, home: 1, away: 2 }, { id: 2, sp: 21, home: 3, away: 4 }, { id: 3, sp: 22, home: 1, away: 3 },
  { id: 4, sp: 23, home: 2, away: 4 }, { id: 5, sp: 24, home: 1, away: 4 }, { id: 6, sp: 25, home: 1, away: 2 },
  { id: 7, sp: 27, home: 3, away: 4 }, { id: 8, sp: 28, home: 2, away: 3 }, { id: 9, sp: 29, home: 1, away: 4 },
];
const rng7 = (a, b) => rep(b - a + 1, (_, i) => a + i);
const PO_WEEKS = [
  { id: 19, playoff: false, label: 'Week 19', range: 'Mar 1 – 7', sps: rng7(14, 20) },
  { id: 20, playoff: true, label: 'Playoffs · round 1', range: 'Mar 8 – 14', sps: rng7(21, 27) },
  { id: 21, playoff: true, label: 'Playoffs · round 2', range: 'Mar 15 – 17', sps: rng7(28, 30) },
];

test('playoffPlanner: games per team and week, totals, back-to-backs, ordering', () => {
  const sched = schedOf(4, PO_GAMES);
  const league = mkLeague();
  const plan = I.playoffPlanner({ league, sched, weeks: PO_WEEKS, factors: null, roster: [], freeAgents: [] });
  assert.deepStrictEqual(plan.weeks, [
    { id: 20, label: 'Playoffs · round 1', range: 'Mar 8 – 14' },
    { id: 21, label: 'Playoffs · round 2', range: 'Mar 15 – 17' },
  ]);
  assert.deepStrictEqual(plan.teams.map((t) => t.proId), [1, 4, 2, 3]); // total desc, then abbrev
  const byId = Object.fromEntries(plan.teams.map((t) => [t.proId, t]));
  assert.deepStrictEqual(byId[1].games, { 20: 4, 21: 1 });
  assert.deepStrictEqual(byId[2].games, { 20: 3, 21: 1 });
  assert.deepStrictEqual(byId[3].games, { 20: 3, 21: 1 });
  assert.deepStrictEqual(byId[4].games, { 20: 4, 21: 1 });
  assert.deepStrictEqual(plan.teams.map((t) => t.total), [5, 5, 4, 4]);
  assert.deepStrictEqual([1, 2, 3, 4].map((id) => byId[id].b2b), [2, 0, 2, 1]);
  assert.strictEqual(byId[1].abbrev, 'T1');
  // no playoff weeks, no rows
  const none = I.playoffPlanner({ league, sched, weeks: PO_WEEKS.slice(0, 1), factors: null, roster: [], freeAgents: [] });
  assert.deepStrictEqual(none.weeks, []);
  assert.ok(none.teams.every((t) => t.total === 0 && t.b2b === 0));
});

test('playoffPlanner: my players include IR, free agents skip OUT and keep the top 25', () => {
  const sched = schedOf(4, PO_GAMES);
  const league = mkLeague();
  const roster = [
    mk(1, { team: 1, proj: 10, slot: 0 }), mk(2, { team: 2, proj: 20, slot: 11 }),
    mk(3, { team: 3, proj: 15, slot: 13, injury: 'OUT' }), mk(4, { team: 4, proj: 13, slot: 12 }),
  ];
  const fas = rep(30, (_, i) => mk(100 + i, { team: 1 + (i % 4), proj: 10 + i, injury: i === 29 || i === 28 ? 'OUT' : 'ACTIVE' }));
  const plan = I.playoffPlanner({ league, sched, weeks: PO_WEEKS, factors: null, roster, freeAgents: fas });
  assert.deepStrictEqual(plan.mine.map((r) => r.player.id), [2, 4, 3, 1]);
  assert.deepStrictEqual(plan.mine.map((r) => r.expFp), [80, 65, 60, 50]);
  assert.deepStrictEqual(plan.mine.map((r) => r.total), [4, 5, 4, 5]);
  assert.deepStrictEqual(plan.mine[3].games, { 20: 4, 21: 1 });
  assert.strictEqual(plan.mine[3].proj.fp, 10);
  assert.strictEqual(plan.fas.length, 25);
  assert.ok(plan.fas.every((r) => r.player.injury === 'ACTIVE'));
  const totals = { 1: 5, 2: 4, 3: 4, 4: 5 };
  const oracle = fas.filter((p) => p.injury !== 'OUT').map((p) => (10 + (p.id - 100)) * totals[p.proTeamId]).sort((a, b) => b - a).slice(0, 25);
  assert.deepStrictEqual(plan.fas.map((r) => r.expFp), oracle);
});

test('playoffPlanner: factors scale expected points, category leagues count games', () => {
  const sched = schedOf(4, PO_GAMES);
  const roster = [mk(1, { team: 1, proj: 10, slot: 0 })];
  const f = { home: 1.1, away: 0.9, b2bOutput: 1, b2bPlay: 0.8, opp: {} };
  const plan = I.playoffPlanner({ league: mkLeague(), sched, weeks: PO_WEEKS, factors: f, roster, freeAgents: [] });
  // T1 is home in all five games; sp22 and sp25 are second nights
  near(plan.mine[0].expFp, 10 * (1.1 + 0.88 + 1.1 + 0.88 + 1.1), 1e-9);
  const cat = I.playoffPlanner({ league: mkLeague({ cat: true }), sched, weeks: PO_WEEKS, factors: f, roster, freeAgents: [] });
  assert.strictEqual(cat.mine[0].expFp, 5);
});

/* -------------------------------------------------------------- trends */

function tr(o) { return I.trends([mk(1, { stats: o })], SEASON)[0]; }

test('trends: averages, base and delta', () => {
  const r = tr([entry('00', 22, 30), entry('01', 28, 4), entry('02', 25, 10), entry('10', 20, 70)]);
  assert.strictEqual(r.avg, 22);
  assert.strictEqual(r.n, 30);
  assert.strictEqual(r.l7, 28);
  assert.strictEqual(r.l15, 25);
  assert.strictEqual(r.n15, 10);
  assert.strictEqual(r.proj, 20);
  assert.strictEqual(r.delta, 5); // against the projection
  assert.strictEqual(r.player.id, 1);
  // no projection: the season average is the base
  const b = tr([entry('00', 20, 30), entry('02', 25, 10)]);
  assert.strictEqual(b.proj, null);
  assert.strictEqual(b.delta, 5);
  // average derived from the total when appliedAverage is missing
  const d = tr([stat('00' + SEASON, { appliedTotal: 100, stats: { 42: 4 } })]);
  assert.strictEqual(d.avg, 25);
  assert.strictEqual(d.n, 4);
  // one row per player, input order
  const rows = I.trends([mk(2, {}), mk(1, {})], SEASON);
  assert.deepStrictEqual(rows.map((x) => x.player.id), [2, 1]);
});

test('trends: rising / falling tags and their thresholds', () => {
  const t = (proj, l15, n15) => tr([entry('10', proj, 70), entry('02', l15, n15 === undefined ? 5 : n15)]);
  assert.strictEqual(t(30, 36).tag, 'rising');
  assert.strictEqual(t(30, 36).delta, 6);
  assert.strictEqual(t(30, 34.4).tag, null); // 34.4 < 1.15 x 30
  assert.strictEqual(t(30, 34.6).tag, 'rising');
  assert.strictEqual(t(40, 44).tag, null); // +4 but only +10%
  assert.strictEqual(t(10, 12.5).tag, null); // +25% but only +2.5
  assert.strictEqual(t(10, 13.5).tag, 'rising');
  assert.strictEqual(t(40, 33).tag, 'falling');
  assert.strictEqual(t(40, 33).delta, -7);
  assert.strictEqual(t(40, 36).tag, null); // -10%
  assert.strictEqual(t(10, 8).tag, null); // -20% but only -2
  assert.strictEqual(t(10, 6.9).tag, 'falling');
  // sample size: needs 3 games in the last 15
  assert.strictEqual(t(20, 30, 2).tag, null);
  assert.strictEqual(t(20, 30, 2).delta, 10);
  assert.strictEqual(t(20, 30, 3).tag, 'rising');
  assert.strictEqual(t(20, 10, 1).tag, null);
  // no projection falls back to the season average
  assert.strictEqual(tr([entry('00', 20, 30), entry('02', 25, 4)]).tag, 'rising');
});

test('trends: roles from starts and minutes, in priority order', () => {
  const role = (cur, l15) => tr([entry('00', 20, cur[0], cur[1], cur[2]), entry('02', 20, l15[0], l15[1], l15[2])]).role;
  // [gp, minutes total, starts total]
  assert.strictEqual(role([20, null, 4], [10, null, 8]), 'new starter');
  assert.strictEqual(role([20, null, 10], [10, null, 8]), null); // season start rate exactly .5 is not "< .5"
  assert.strictEqual(role([20, null, 4], [10, null, 6]), 'new starter'); // .6 is enough
  assert.strictEqual(role([20, null, 4], [10, null, 5]), null);
  assert.strictEqual(role([20, null, 18], [10, null, 2]), 'lost start');
  assert.strictEqual(role([20, null, 12], [10, null, 3]), 'lost start'); // season .6 counts
  assert.strictEqual(role([20, null, 18], [10, null, 4]), null); // last 15 exactly .4 is not "< .4"
  assert.strictEqual(role([20, null, 11], [10, null, 2]), null); // season .55 is not a regular starter
  // minutes: 25 per game before, 29 / 28.9 / 21 / 21.1 lately
  assert.strictEqual(role([20, 500, null], [10, 290, null]), 'more minutes');
  assert.strictEqual(role([20, 500, null], [10, 289, null]), null);
  assert.strictEqual(role([20, 500, null], [10, 210, null]), 'fewer minutes');
  assert.strictEqual(role([20, 500, null], [10, 211, null]), null);
  // starter changes beat minute changes
  assert.strictEqual(role([20, 500, 4], [10, 400, 8]), 'new starter');
  assert.strictEqual(role([20, 500, 18], [10, 200, 2]), 'lost start');
});

test('trends: missing stats give nulls, never a tag or role', () => {
  const none = I.trends([mk(1, {})], SEASON)[0];
  assert.deepStrictEqual(Object.assign({}, none, { player: null }), {
    player: null, avg: null, n: 0, l7: null, l15: null, n15: 0, proj: null, mpg: null, mpgL15: null,
    startRate: null, startRateL15: null, delta: null, tag: null, role: null,
  });
  // only a projection
  const p = tr([entry('10', 18, 70)]);
  assert.strictEqual(p.proj, 18);
  assert.strictEqual(p.delta, null);
  assert.strictEqual(p.tag, null);
  // minutes only in one window, no starts anywhere
  const m = tr([entry('00', 20, 20, 500, null), entry('02', 20, 10, null, null)]);
  assert.strictEqual(m.mpg, 25);
  assert.strictEqual(m.mpgL15, null);
  assert.strictEqual(m.startRate, null);
  assert.strictEqual(m.role, null);
  // zero games played in the window
  const z = tr([entry('00', 0, 0, 0, 0), entry('02', 0, 0, 0, 0)]);
  assert.strictEqual(z.avg, null);
  assert.strictEqual(z.mpg, null);
  assert.strictEqual(z.role, null);
  // a stat entry from another season is ignored
  const old = I.trends([mk(1, { stats: [stat('002026', { appliedAverage: 50, stats: { 42: 70 } })] })], SEASON)[0];
  assert.strictEqual(old.avg, null);
  assert.deepStrictEqual(I.trends([], SEASON), []);
  assert.deepStrictEqual(I.trends(null, SEASON), []);
});

test('trends: per-game rates use stats 40 and 41 over games played', () => {
  const r = tr([entry('00', 20, 20, 560, 10), entry('02', 22, 8, 264, 8)]);
  assert.strictEqual(r.mpg, 28);
  assert.strictEqual(r.mpgL15, 33);
  assert.strictEqual(r.startRate, 0.5);
  assert.strictEqual(r.startRateL15, 1);
});

/* --------------------------------------------------------- buyLowSellHigh */

test('buyLowSellHigh: only falling players on other teams with a real base, rising players of mine', () => {
  const ME = 6;
  const pl = (id, team, proj, l15) => mk(id, { onTeamId: team, stats: [entry('10', proj, 70), entry('02', l15, 6)] });
  const players = [
    pl(100, 1, 40, 30), // other team, falling, delta -10
    pl(203, 2, 25, 19), // base exactly 25 qualifies, delta -6
    pl(202, 2, 24, 15), // base below 25: left out
    pl(200, ME, 40, 20), // mine, falling: not a buy
    pl(201, undefined, 40, 20), // free agent: not a buy
    pl(204, 2, 40, 39), // no tag
    pl(205, 3, 40, 12), // delta -28, the biggest drop
    pl(300, ME, 20, 28), pl(301, ME, 20, 31), pl(302, ME, 30, 36), // mine, rising: +8, +11, +6
    pl(303, 2, 20, 40), // rising on another team: not mine
    pl(304, ME, 30, 20), // mine, falling: not a sell
  ];
  const { buyLow, sellHigh } = I.buyLowSellHigh(I.trends(players, SEASON), ME);
  assert.deepStrictEqual(buyLow.map((r) => r.player.id), [205, 100, 203]); // delta ascending
  assert.ok(buyLow.every((r) => r.tag === 'falling' && r.player.onTeamId !== ME && r.player.onTeamId != null));
  assert.deepStrictEqual(sellHigh.map((r) => r.player.id), [301, 300, 302]); // delta descending
  assert.ok(sellHigh.every((r) => r.tag === 'rising' && r.player.onTeamId === ME));
  assert.deepStrictEqual(I.buyLowSellHigh([], ME), { buyLow: [], sellHigh: [] });
  // team ids may be strings on one side and numbers on the other
  assert.strictEqual(I.buyLowSellHigh(I.trends(players, SEASON), '6').sellHigh.length, 3);
});

test('buyLowSellHigh: buy-low list is capped at 15 and uses the average when there is no projection', () => {
  const players = [];
  for (let i = 0; i < 17; i++) {
    players.push(mk(100 + i, { onTeamId: 1 + (i % 3), stats: [entry('10', 40, 70), entry('02', 30 - i * 0.2, 6)] })); // delta -10 .. -13.2
  }
  players.push(mk(500, { onTeamId: 2, stats: [entry('00', 30, 40), entry('02', 10, 6)] })); // no projection, base = average 30
  const { buyLow } = I.buyLowSellHigh(I.trends(players, SEASON), 6);
  assert.strictEqual(buyLow.length, 15);
  assert.strictEqual(buyLow[0].player.id, 500); // delta -20
  assert.strictEqual(buyLow[1].player.id, 116); // delta -13.2
  for (let i = 1; i < buyLow.length; i++) assert.ok(buyLow[i - 1].delta <= buyLow[i].delta);
  assert.ok(!buyLow.some((r) => r.player.id === 100 || r.player.id === 101));
});

/* ------------------------------------------------------------ rosValue */

test('rosValue: hand-computed lineup totals, OUT and IR excluded', () => {
  const sched = schedOf(4, halfDay(14));
  const league = mkLeague(); // PG x1, C x1, UTIL x2
  const roster = [
    mk(1, { team: 1, proj: 30, slot: 0, elig: PG }), mk(2, { team: 1, proj: 40, slot: 4, elig: CE }),
    mk(3, { team: 3, proj: 20, slot: 11, elig: PG }), mk(4, { team: 1, proj: 10, slot: 12, elig: CE, injury: 'OUT' }),
    mk(5, { team: 1, proj: 50, slot: 13, elig: PG, injury: 'OUT' }), mk(6, { team: 2, proj: 5, slot: 12, elig: PG }),
    mk(7, { team: 1, proj: 60, slot: 12, elig: PG, injury: 'INJURY_RESERVE' }), mk(8, { team: 1, proj: 70, slot: 13, elig: PG }),
  ];
  // odd days: players 1, 2, 6 play = 75; even days: 1, 2, 3, 6 = 95
  const full = I.rosValue({ league, sched, factors: null, roster, fromSp: 1, toSp: 14 });
  assert.strictEqual(full.days, 14);
  assert.strictEqual(full.total, 7 * 75 + 7 * 95);
  assert.strictEqual(full.perWeek, 595);
  const part = I.rosValue({ league, sched, factors: null, roster, fromSp: 1, toSp: 7 });
  assert.strictEqual(part.days, 7);
  assert.strictEqual(part.total, 4 * 75 + 3 * 95);
  near(part.perWeek, 585, 1e-9);
  // empty range and empty roster
  assert.deepStrictEqual(I.rosValue({ league, sched, factors: null, roster, fromSp: 9, toSp: 8 }), { total: 0, perWeek: 0, days: 0 });
  assert.deepStrictEqual(I.rosValue({ league, sched, factors: null, roster: [], fromSp: 1, toSp: 7 }), { total: 0, perWeek: 0, days: 7 });
  // accepts the { current } roster shape too
  assert.strictEqual(I.rosValue({ league, sched, factors: null, roster: { current: roster }, fromSp: 1, toSp: 14 }).total, full.total);
});

test('rosValue: lineup caps limit the total and the range stops at the final period', () => {
  const sched = schedOf(4, halfDay(14));
  // 8 guards who all play every day, but only PG + 2 UTIL slots take a guard
  const roster = rep(8, (_, i) => mk(10 + i, { team: 1, proj: 10, slot: i < 3 ? 0 : 12, elig: PG }));
  const v = I.rosValue({ league: mkLeague(), sched, factors: null, roster, fromSp: 1, toSp: 14 });
  assert.strictEqual(v.total, 14 * 30);
  assert.strictEqual(v.perWeek, 210);
  // the season ends on sp 14: asking for 100 days only counts 14
  const short = mkLeague({ finalSp: 14 });
  const w = I.rosValue({ league: short, sched, factors: null, roster, fromSp: 1, toSp: 100 });
  assert.strictEqual(w.days, 14);
  assert.strictEqual(w.perWeek, 210);
});

test('rosValue: factors apply in points leagues only', () => {
  const sched = schedOf(4, halfDay(14));
  const f = { home: 1.2, away: 0.8, b2bOutput: 1, b2bPlay: 1, opp: {} };
  const roster = [mk(1, { team: 1, proj: 10, slot: 0, elig: PG })];
  const args = { league: mkLeague(), sched, roster, fromSp: 1, toSp: 14 };
  assert.strictEqual(I.rosValue(Object.assign({ factors: null }, args)).perWeek, 70);
  near(I.rosValue(Object.assign({ factors: f }, args)).perWeek, 84, 1e-9); // team 1 is always at home
  const away = [mk(2, { team: 2, proj: 10, slot: 0, elig: PG })];
  near(I.rosValue(Object.assign({ factors: f }, args, { roster: away })).perWeek, 56, 1e-9);
  // category league: every game is worth 1 and factors are ignored
  const cat = Object.assign({}, args, { league: mkLeague({ cat: true }), roster: [mk(1, { team: 1, proj: 10, slot: 0, elig: PG }), mk(2, { team: 1, proj: 99, slot: 12, elig: PG })] });
  assert.strictEqual(I.rosValue(Object.assign({ factors: f }, cat)).perWeek, 14);
  assert.strictEqual(I.rosValue(Object.assign({ factors: null }, cat)).perWeek, 14);
});

/* --------------------------------------------------------- analyzeTrade */

// every pro team plays every day; 2 PG + 2 C starters, 1 bench, 1 IR  => roster size 5
const TRADE_SLOTS = { 0: 2, 4: 2, 12: 1, 13: 1 };
function tradeFixture() {
  const sched = schedOf(4, everyDay(30));
  const league = mkLeague({ slots: TRADE_SLOTS });
  const me = [
    mk(1, { team: 1, proj: 30, slot: 0, elig: PG, name: 'a' }), mk(2, { team: 1, proj: 28, slot: 0, elig: PG, name: 'b' }),
    mk(3, { team: 1, proj: 26, slot: 12, elig: PG, name: 'c' }), mk(4, { team: 2, proj: 12, slot: 4, elig: CE, name: 'd' }),
    mk(5, { team: 2, proj: 1, slot: 12, elig: PG, name: 'z' }),
  ];
  const them = [
    mk(11, { team: 3, proj: 40, slot: 4, elig: CE, name: 'e' }), mk(12, { team: 3, proj: 38, slot: 4, elig: CE, name: 'f' }),
    mk(13, { team: 3, proj: 36, slot: 12, elig: CE, name: 'g' }), mk(14, { team: 4, proj: 10, slot: 0, elig: PG, name: 'h' }),
    mk(15, { team: 4, proj: 2, slot: 12, elig: CE, name: 'y' }),
  ];
  return { league, sched, rosters: { 6: me, 4: them }, base: { league, sched, factors: null, rosters: { 6: me, 4: them }, myTeamId: 6, otherTeamId: 4, fromSp: 1, toSp: 14 } };
}

test('analyzeTrade: 1-for-1 hand-computed gains for both sides, mirrored from the other side', () => {
  const fx = tradeFixture();
  const r = I.analyzeTrade(Object.assign({}, fx.base, { give: [3], get: [13] }));
  // me: PG a+b = 58, C d = 12 -> 70/day;  after: C g 36 + d 12 -> 106/day.  Per week x7
  assert.strictEqual(r.me.before, 490);
  assert.strictEqual(r.me.after, 742);
  assert.strictEqual(r.me.delta, 252);
  // them: C e+f = 78, PG h = 10 -> 88/day;  after: PG h 10 + c 26 -> 114/day
  assert.strictEqual(r.them.before, 616);
  assert.strictEqual(r.them.after, 798);
  assert.strictEqual(r.them.delta, 182);
  assert.deepStrictEqual(r.drops, { me: null, them: null });
  // the same trade seen from the other team swaps the two sides
  const m = I.analyzeTrade(Object.assign({}, fx.base, { myTeamId: 4, otherTeamId: 6, give: [13], get: [3] }));
  assert.deepStrictEqual(m.me, r.them);
  assert.deepStrictEqual(m.them, r.me);
  // before matches rosValue of the current roster
  const rv = I.rosValue({ league: fx.league, sched: fx.sched, factors: null, roster: fx.rosters[6], fromSp: 1, toSp: 14 });
  assert.strictEqual(rv.perWeek, r.me.before);
  // an empty trade changes nothing
  const none = I.analyzeTrade(Object.assign({}, fx.base, { give: [], get: [] }));
  assert.strictEqual(none.me.delta, 0);
  assert.strictEqual(none.them.delta, 0);
  assert.deepStrictEqual(none.drops, { me: null, them: null });
  // unknown ids are ignored
  const ghost = I.analyzeTrade(Object.assign({}, fx.base, { give: [999], get: [] }));
  assert.strictEqual(ghost.me.delta, 0);
});

test('analyzeTrade: a side that ends over the roster size drops its lowest-projected player', () => {
  const fx = tradeFixture();
  // 1-for-2: I give c and get f and g -> 6 players on my side (limit 5): z (1.0) goes
  const r = I.analyzeTrade(Object.assign({}, fx.base, { give: [3], get: [12, 13] }));
  assert.strictEqual(r.drops.me.id, 5);
  assert.strictEqual(r.drops.them, null);
  // me after: PG a+b 58, C f+g 74 -> 132/day vs 70
  assert.strictEqual(r.me.delta, (132 - 70) * 7);
  // them after: C e + y 42, PG h + c 36 -> 78/day vs 88
  assert.strictEqual(r.them.delta, (78 - 88) * 7);
  // 2-for-1: I give c and z, get g -> they hold 6 and drop the lowest (the incoming z)
  const s = I.analyzeTrade(Object.assign({}, fx.base, { give: [3, 5], get: [13] }));
  assert.strictEqual(s.drops.them.id, 5);
  assert.strictEqual(s.drops.me, null);
  assert.strictEqual(s.me.delta, 252);
  assert.strictEqual(s.them.delta, 182);
  // IR players do not count towards the roster size
  const ir = tradeFixture();
  ir.rosters[4].push(mk(16, { team: 3, proj: 5, slot: 13, elig: CE, injury: 'OUT', name: 'ir' }));
  const t = I.analyzeTrade(Object.assign({}, ir.base, { rosters: ir.rosters, give: [3, 5], get: [13] }));
  assert.strictEqual(t.drops.them.id, 5);
  const t2 = I.analyzeTrade(Object.assign({}, ir.base, { rosters: ir.rosters, give: [3], get: [13] }));
  assert.strictEqual(t2.drops.them, null);
});

/* ---------------------------------------------------------- tradeIdeas */

// "too many centres" (me) vs "too many guards" (team 4); team 5 is balanced
function surplusFixture() {
  const sched = schedOf(4, everyDay(30));
  const league = mkLeague({ slots: { 0: 2, 4: 2, 12: 2, 13: 1 }, cur: 1 });
  const C = (id, fp, team) => mk(id, { team, proj: fp, slot: 4, elig: CE, name: 'C' + id });
  const G = (id, fp, team) => mk(id, { team, proj: fp, slot: 0, elig: PG, name: 'G' + id });
  const me = [C(1, 40, 1), C(2, 38, 1), C(3, 36, 1), C(4, 34, 1), G(5, 10, 2)];
  const t4 = [G(11, 30, 3), G(12, 28, 3), G(13, 26, 3), G(14, 24, 3), C(15, 12, 4)];
  const t5 = [G(21, 20, 3), G(22, 18, 4), C(23, 20, 4), C(24, 18, 4), G(25, 5, 4)];
  const rosters = { 6: me, 4: t4, 5: t5 };
  return { league, sched, rosters, args: { league, sched, factors: null, rosters, myTeamId: 6, fromSp: 1 } };
}

test('tradeIdeas: swaps a surplus of centres for a surplus of guards, both sides gain', () => {
  const fx = surplusFixture();
  const ideas = I.tradeIdeas(Object.assign({}, fx.args, { limit: 500 }));
  assert.ok(ideas.length > 0);
  assert.ok(ideas.every((x) => x.myGain > 0 && x.theirGain > 0));
  assert.ok(ideas.every((x) => x.teamId !== 6 && (x.teamId === 4 || x.teamId === 5)));
  for (let i = 1; i < ideas.length; i++) {
    assert.ok(Math.min(ideas[i - 1].myGain, ideas[i - 1].theirGain) >= Math.min(ideas[i].myGain, ideas[i].theirGain) - 1e-9);
  }
  // the obvious idea: a centre for their two spare guards, +38 a day for both. Two ways tie for best:
  // C2 for G13 + G14 (26 + 24), or C1 for G12 + G14 (28 + 24).
  const best = ideas[0];
  assert.strictEqual(best.teamId, 4);
  near(Math.min(best.myGain, best.theirGain), 38 * 7);
  assert.ok(ideas.every((x) => Math.min(x.myGain, x.theirGain) <= 38 * 7 + 1e-6));
  const c2 = ideas.find((x) => x.give.length === 1 && x.give[0].id === 2 && x.get.map((p) => p.id).sort().join() === '13,14');
  assert.ok(c2);
  near(c2.myGain, 38 * 7);
  near(c2.theirGain, 38 * 7);
  // plain 1-for-1: a spare centre for a spare guard
  const swap = ideas.find((x) => x.teamId === 4 && x.give.length === 1 && x.get.length === 1 && x.give[0].id === 3 && x.get[0].id === 13);
  assert.ok(swap);
  near(swap.myGain, 26 * 7); // fills my empty guard slot, costs me nothing
  near(swap.theirGain, 36 * 7); // fills their empty centre slot
  // multi-player ideas only ever trade quantity for the better single player
  const fp = (p) => M.projectPlayer(p, SEASON, true).fp;
  ideas.forEach((x) => {
    if (x.give.length === 2 && x.get.length === 1) assert.ok(fp(x.get[0]) > fp(x.give[0]) && fp(x.get[0]) > fp(x.give[1]));
    if (x.give.length === 1 && x.get.length === 2) assert.ok(fp(x.give[0]) > fp(x.get[0]) && fp(x.give[0]) > fp(x.get[1]));
    assert.ok(x.give.length >= 1 && x.get.length >= 1 && x.give.length + x.get.length <= 3);
  });
  // limit and default limit
  assert.strictEqual(I.tradeIdeas(Object.assign({}, fx.args, { limit: 3 })).length, 3);
  assert.ok(I.tradeIdeas(fx.args).length <= 20);
});

test('tradeIdeas: finds 2-for-1 shapes too', () => {
  const sched = schedOf(4, everyDay(30));
  const league = mkLeague({ slots: { 0: 2, 4: 2, 12: 2, 13: 1 }, cur: 1 });
  const C = (id, fp, team, slot) => mk(id, { team, proj: fp, slot, elig: CE });
  const G = (id, fp, team, slot) => mk(id, { team, proj: fp, slot, elig: PG });
  // I am short of a guard and hold two spare centres; they hold a spare guard and two empty centre slots
  const me = [C(1, 40, 1, 4), C(2, 38, 1, 4), C(3, 20, 1, 12), C(4, 18, 1, 12), G(5, 10, 2, 0)];
  const them = [G(11, 30, 3, 0), G(12, 29, 3, 0), G(13, 28, 3, 12)];
  const rosters = { 6: me, 4: them };
  const ideas = I.tradeIdeas({ league, sched, factors: null, rosters, myTeamId: 6, fromSp: 1, limit: 500 });
  const two = ideas.find((x) => x.give.length === 2 && x.get.length === 1 && x.get[0].id === 13);
  assert.ok(two, 'expected a 2-for-1');
  assert.deepStrictEqual(two.give.map((p) => p.id).sort(), [3, 4]);
  near(two.myGain, 28 * 7);
  near(two.theirGain, 38 * 7);
  assert.ok(ideas.every((x) => x.myGain > 0 && x.theirGain > 0));
});

// every returned idea is re-checked with the (independent, un-memoised) analyzeTrade
function randomLeague(o) {
  const rng = mulberry(o.seed);
  const caps = o.caps;
  const slots = Object.assign({}, caps, { 12: o.bench, 13: 1 });
  const sched = (() => {
    const games = []; let id = 1;
    for (let sp = 1; sp <= o.days; sp++) {
      const ids = rep(30, (_, i) => i + 1);
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp; }
      const n = 11 + Math.floor(rng() * 5);
      for (let k = 0; k < n; k++) games.push({ id: id++, sp, home: ids[2 * k], away: ids[2 * k + 1] });
    }
    return schedOf(30, games);
  })();
  const teams = rep(o.teams, (_, i) => ({ id: i + 1, name: 'Team ' + (i + 1), abbrev: 'TM' + (i + 1), record: { overall: { wins: 0, losses: 0, ties: 0 } } }));
  const league = mkLeague({ slots, cur: 1, teams });
  const capSlots = Object.keys(caps).map(Number);
  const rosters = {};
  let pid = 1;
  for (let t = 1; t <= o.teams; t++) {
    rosters[t] = rep(o.perTeam, (_, i) => {
      const elig = POSES[Math.floor(rng() * POSES.length)].filter((s) => s >= 11 || capSlots.indexOf(s) >= 0 || s === 12 || s === 13);
      const last = i === o.perTeam - 1;
      const fp = 5 + Math.floor(rng() * 400) / 10;
      const injury = last ? 'OUT' : (rng() < 0.06 ? 'OUT' : (rng() < 0.1 ? 'DAY_TO_DAY' : 'ACTIVE'));
      return mk(pid++, { team: 1 + Math.floor(rng() * 30), proj: fp, slot: last ? 13 : (i < league.starters ? 11 : 12), elig, injury, name: 'P' + pid, onTeamId: t });
    });
  }
  return { league, sched, rosters };
}

function bruteMins(fx, myTeamId, fromSp) {
  const mins = [];
  const OUT = M.OUT_STATUSES;
  const fpOf = (p) => M.projectPlayer(p, SEASON, true).fp;
  const cands = (r) => r.filter((p) => p.slot !== 13 && OUT.indexOf(p.injury) < 0).map((p) => ({ p, fp: fpOf(p) }))
    .sort((a, b) => (b.fp - a.fp) || (a.p.id - b.p.id)).slice(0, 10);
  const cm = cands(fx.rosters[myTeamId]);
  Object.keys(fx.rosters).filter((k) => +k !== myTeamId).forEach((k) => {
    const ct = cands(fx.rosters[k]);
    const tryIt = (g, x) => {
      const r = I.analyzeTrade({ league: fx.league, sched: fx.sched, factors: null, rosters: fx.rosters, myTeamId, otherTeamId: +k, give: g.map((e) => e.p.id), get: x.map((e) => e.p.id), fromSp, toSp: fromSp + 27 });
      if (r.me.delta > 1e-7 && r.them.delta > 1e-7) mins.push(Math.min(r.me.delta, r.them.delta));
    };
    cm.forEach((g) => ct.forEach((x) => tryIt([g], [x])));
    for (let i = 0; i < cm.length; i++) for (let j = i + 1; j < cm.length; j++) ct.forEach((x) => { if (x.fp > cm[i].fp && x.fp > cm[j].fp) tryIt([cm[i], cm[j]], [x]); });
    cm.forEach((g) => { for (let i = 0; i < ct.length; i++) for (let j = i + 1; j < ct.length; j++) if (g.fp > ct[i].fp && g.fp > ct[j].fp) tryIt([g], [ct[i], ct[j]]); });
  });
  return mins.sort((a, b) => b - a);
}

test('tradeIdeas: matches a brute-force search made with analyzeTrade (incl. forced drops)', () => {
  const caps = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 11: 1 }; // 6 starters
  // rosters of 9 / 8 / 7 (one on IR): full at the roster limit, full, and one spot open
  const configs = [{ seed: 13, perTeam: 9, bench: 2 }, { seed: 15, perTeam: 8, bench: 1 }, { seed: 12, perTeam: 7, bench: 1 }];
  let withDrops = 0, shapes = new Set();
  configs.forEach((c) => {
    const fx = randomLeague({ seed: c.seed, teams: 3, perTeam: c.perTeam, caps, bench: c.bench, days: 40 });
    const args = { league: fx.league, sched: fx.sched, factors: null, rosters: fx.rosters, myTeamId: 1, fromSp: 1, limit: 1000 };
    const ideas = I.tradeIdeas(args);
    const want = bruteMins(fx, 1, 1);
    assert.ok(want.length > 3, 'fixture should produce some trades, got ' + want.length);
    const got = ideas.map((x) => Math.min(x.myGain, x.theirGain));
    assert.strictEqual(got.length, want.length);
    got.forEach((v, i) => near(v, want[i], 1e-6));
    // each idea round-trips through the analyzer
    ideas.forEach((x) => {
      shapes.add(x.give.length + 'for' + x.get.length);
      const r = I.analyzeTrade({ league: fx.league, sched: fx.sched, factors: null, rosters: fx.rosters, myTeamId: 1, otherTeamId: x.teamId, give: x.give.map((p) => p.id), get: x.get.map((p) => p.id), fromSp: 1, toSp: 28 });
      near(r.me.delta, x.myGain, 1e-6);
      near(r.them.delta, x.theirGain, 1e-6);
      if (r.allDrops.me.length || r.allDrops.them.length) withDrops++;
    });
    // a shorter horizon gives different (and still consistent) numbers
    const short = I.tradeIdeas(Object.assign({}, args, { horizonDays: 10, limit: 5 }));
    short.forEach((x) => {
      const r = I.analyzeTrade({ league: fx.league, sched: fx.sched, factors: null, rosters: fx.rosters, myTeamId: 1, otherTeamId: x.teamId, give: x.give.map((p) => p.id), get: x.get.map((p) => p.id), fromSp: 1, toSp: 10 });
      near(r.me.delta, x.myGain, 1e-6);
      near(r.them.delta, x.theirGain, 1e-6);
    });
  });
  assert.ok(withDrops > 0, 'some ideas should involve a forced drop');
  assert.ok(shapes.has('1for1'), 'shapes seen: ' + [...shapes]);
});

const BIG_CAPS = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 3 };

test('rosValue agrees with a day-by-day WPModel.bestLineup oracle on random rosters', () => {
  const fx = randomLeague({ seed: 5, teams: 6, perTeam: 14, caps: BIG_CAPS, bench: 3, days: 40 });
  [null, FACT].forEach((factors) => {
    Object.keys(fx.rosters).forEach((id) => {
      let want = 0;
      for (let sp = 3; sp < 3 + 21; sp++) {
        const cands = [];
        fx.rosters[id].forEach((p) => {
          if (p.slot === 13 || M.OUT_STATUSES.indexOf(p.injury) >= 0 || !M.teamGame(fx.sched, p.proTeamId, sp)) return;
          cands.push({ key: String(p.id), w: M.projectPlayer(p, SEASON, true).fp * M.gameMult(fx.sched, factors, p.proTeamId, sp).mult, slots: p.eligible });
        });
        want += M.bestLineup(cands, fx.league.caps).total;
      }
      const got = I.rosValue({ league: fx.league, sched: fx.sched, factors, roster: fx.rosters[id], fromSp: 3, toSp: 23 });
      near(got.total, want, 1e-6);
      near(got.perWeek, want / 21 * 7, 1e-6);
      assert.strictEqual(got.days, 21);
    });
  });
});

test('tradeIdeas and powerRankings run in under 2 s for 16 teams x 14 players and 28 days', (t) => {
  const fx = randomLeague({ seed: 2027, teams: 16, perTeam: 14, caps: BIG_CAPS, bench: 3, days: 60 });
  assert.strictEqual(fx.league.starters, 10);
  const args = { league: fx.league, sched: fx.sched, factors: FACT, rosters: fx.rosters, myTeamId: 6, fromSp: 1 };
  let t0 = performance.now();
  const ideas = I.tradeIdeas(args);
  const tIdeas = performance.now() - t0;
  t0 = performance.now();
  const rank = I.powerRankings(Object.assign({ matchups: [] }, args));
  const tRank = performance.now() - t0;
  t.diagnostic('tradeIdeas ' + tIdeas.toFixed(0) + ' ms (' + ideas.length + ' ideas), powerRankings ' + tRank.toFixed(0) + ' ms');
  assert.ok(tIdeas < 2000, 'tradeIdeas took ' + tIdeas + ' ms');
  assert.ok(tRank < 2000, 'powerRankings took ' + tRank + ' ms');
  assert.ok(ideas.length > 0 && ideas.length <= 20);
  assert.ok(ideas.every((x) => x.myGain > 0 && x.theirGain > 0));
  assert.strictEqual(rank.length, 16);
  // the top few ideas agree with the un-memoised analyzer (with factors and forced drops on full rosters)
  ideas.slice(0, 5).forEach((x) => {
    const r = I.analyzeTrade(Object.assign({}, args, { otherTeamId: x.teamId, give: x.give.map((p) => p.id), get: x.get.map((p) => p.id), toSp: 28 }));
    near(r.me.delta, x.myGain, 1e-6);
    near(r.them.delta, x.theirGain, 1e-6);
  });
  // deterministic
  assert.deepStrictEqual(I.tradeIdeas(args).map((x) => [x.teamId, x.myGain, x.theirGain]), ideas.map((x) => [x.teamId, x.myGain, x.theirGain]));
});

/* -------------------------------------------------------- powerRankings */

test('powerRankings: order by strength, points for from past matchups, schedule strength', () => {
  const sched = schedOf(4, everyDay(40));
  const mkTeam = (id, fp, wins) => ({ id, name: 'Team ' + id, abbrev: 'TM' + id, record: { overall: { wins, losses: 2 - wins, ties: 0 } } });
  const league = mkLeague({ cur: 1, mp: 3, regular: 5, teams: [mkTeam(1, 0, 1), mkTeam(2, 0, 2), mkTeam(3, 0, 0), mkTeam(4, 0, 1)] });
  const roster = (base, fp) => rep(4, (_, i) => mk(base + i, { team: 1, proj: fp, slot: i < 4 ? [0, 4, 11, 11][i] : 12, elig: i === 1 ? CE : PG }));
  const rosters = { 1: roster(10, 20), 2: roster(20, 40), 3: roster(30, 10), 4: roster(40, 30) };
  const side = (teamId, total) => ({ teamId, total, bySp: {} });
  const matchups = [
    { mp: 1, home: side(1, 100), away: side(2, 90) }, { mp: 1, home: side(3, 80), away: side(4, 70) },
    { mp: 2, home: side(1, 110), away: side(3, 60) }, { mp: 2, home: side(2, 95), away: side(4, 105) },
    { mp: 3, home: side(1, 50), away: side(4, 40) }, { mp: 3, home: side(2, 30), away: side(3, 20) }, // current week: not in pf
    { mp: 4, home: side(1, 0), away: side(2, 0) }, { mp: 4, home: side(3, 0), away: null }, // team 3 has a bye
    { mp: 5, home: side(1, 0), away: side(3, 0) }, { mp: 5, home: side(2, 0), away: side(4, 0) },
    { mp: 6, home: side(1, 0), away: side(2, 0) }, // beyond the regular season: ignored
  ];
  const args = { league, sched, factors: null, rosters, matchups, fromSp: 1 };
  const rows = I.powerRankings(args);
  assert.deepStrictEqual(rows.map((r) => r.teamId), [2, 4, 1, 3]);
  assert.deepStrictEqual(rows.map((r) => r.rank), [1, 2, 3, 4]);
  // 4 starters every day: strength per week = 4 x fp x 7
  assert.deepStrictEqual(rows.map((r) => r.strength), [1120, 840, 560, 280]);
  const rv = I.rosValue({ league, sched, factors: null, roster: rosters[2], fromSp: 1, toSp: 28 });
  assert.strictEqual(rows[0].strength, rv.perWeek);
  const by = Object.fromEntries(rows.map((r) => [r.teamId, r]));
  assert.deepStrictEqual([1, 2, 3, 4].map((id) => by[id].pf), [210, 185, 140, 175]);
  assert.deepStrictEqual(by[2].record, { wins: 2, losses: 0, ties: 0 });
  assert.strictEqual(by[3].name, 'Team 3');
  assert.strictEqual(by[3].abbrev, 'TM3');
  // remaining regular season (mp 3..5): team 1 faces 4, 2, 3
  near(by[1].sos, (840 + 1120 + 280) / 3);
  near(by[2].sos, (280 + 560 + 840) / 3); // team 2 faces 3, 1, 4
  near(by[3].sos, (1120 + 560) / 2); // mp3 vs 2, mp5 vs 1; the mp4 bye does not count
  near(by[4].sos, (560 + 1120) / 2);
  // matchups come from the argument, not the league
  assert.strictEqual(league.matchups.length, 0);
  // falls back to league.matchups
  const viaLeague = I.powerRankings(Object.assign({}, args, { matchups: undefined, league: Object.assign({}, league, { matchups }) }));
  assert.deepStrictEqual(viaLeague, rows);
  // season over: no remaining opponents
  const late = I.powerRankings(Object.assign({}, args, { league: Object.assign({}, league, { currentMp: 6 }) }));
  assert.ok(late.every((r) => r.sos === null));
  assert.strictEqual(late.find((r) => r.teamId === 1).pf, 260); // matchups 1-5 now count (100 + 110 + 50)
  // injuries drop a team down the order
  const hurt = Object.assign({}, rosters, { 2: rosters[2].map((p) => Object.assign({}, p, { injury: 'OUT' })) });
  const after = I.powerRankings(Object.assign({}, args, { rosters: hurt }));
  assert.strictEqual(after[after.length - 1].teamId, 2);
  assert.strictEqual(after[after.length - 1].strength, 0);
});

/* --------------------------------------------------------------- digest */

function digestFixture() {
  const p = (id, name, slot, injury) => mk(id, { name, slot, injury: injury || 'ACTIVE', team: 1 });
  const row = (player, cell, gone) => ({ player, gone: !!gone, cells: cell ? { 9: cell } : {} });
  const al = p(1, 'Al Smith', 0), cal = p(2, 'Cal Two', 4, 'OUT'), dee = p(3, 'Dee Dtd', 11, 'DAY_TO_DAY');
  const eli = p(4, 'Eli Four', 12), ira = p(5, 'Ira Six', 13, 'OUT'), gil = p(6, 'Gil Gone', 12, 'OUT'), fox = p(7, 'Fox Away', 12);
  const vm = {
    week: { label: 'Week 2', range: 'Oct 26 – Nov 1' },
    days: [{ sp: 9, kind: 'today' }, { sp: 10, kind: 'future' }],
    gamesPerTeam: [{ count: 4, teams: [{ id: 1, abbrev: 'ATL' }, { id: 2, abbrev: 'BOS' }] }],
    me: {
      name: 'Thanos was right', actual: 541.4, projFinal: 812.34, days: { 9: { open: 3 } },
      rows: [
        row(al, cellP(30)), row(cal, cellP(40, { out: true, start: false })), row(dee, cellP(25, { dtd: true })), row(eli, null),
        row(ira, null), row(gil, null, true),
      ],
    },
    opp: { name: 'Lebrontocracy', actual: 646.6, projFinal: 790.04, rows: [] },
    recs: {
      byDay: { 9: [{ sp: 9, fa: Object.assign({}, mk(50, { name: 'Jock Landale', team: 1 }), { pos: 'C' }), drop: mk(51, { name: 'Sexton' }), gain: 21.46, waiver: false }] },
      note: null,
    },
  };
  const wp = { pWin: 0.58, pTie: 0, me: { mean: 800, sd: 40 }, opp: { mean: 790, sd: 40 } };
  const trendRows = [
    { player: al, role: 'new starter', tag: null }, { player: eli, role: null, tag: 'rising' },
    { player: fox, role: 'more minutes', tag: null }, { player: gil, role: 'lost start', tag: null },
  ];
  return { vm, wp, trendRows, al, cal, dee, eli, fox };
}

test('digest: score, win chance, today, injuries, roles and the best add', () => {
  const fx = digestFixture();
  const text = I.digest({ vm: fx.vm, wp: fx.wp, trendRows: fx.trendRows, today: 9 });
  const lines = text.split('\n');
  assert.strictEqual(lines[0], 'Week 2 · Oct 26 – Nov 1: Thanos was right 541.4, Lebrontocracy 646.6');
  assert.ok(lines.includes('Projected final: 812.3 to 790.0'));
  assert.ok(lines.includes('Win chance: 58%'));
  assert.ok(lines.includes('Today: 2 of 4 players play')); // Al and Dee; Cal is out, Eli has no game; IR and gone rows do not count
  assert.ok(lines.includes('Open lineup slots today: 3'));
  const inj = lines.find((l) => l.startsWith('Injuries:'));
  assert.ok(inj.includes('Cal Two (OUT)') && inj.includes('Dee Dtd (DTD)') && inj.includes('Ira Six (OUT)'));
  assert.ok(!inj.includes('Gil Gone') && !inj.includes('Al Smith'));
  const roles = lines.find((l) => l.startsWith('Role changes:'));
  assert.ok(roles.includes('Al Smith (new starter)'));
  assert.ok(!roles.includes('Fox Away')); // not on my rows
  assert.ok(!roles.includes('Gil Gone')); // gone from my roster
  const add = lines.find((l) => l.startsWith('Best add today:'));
  assert.ok(add.includes('Jock Landale') && add.includes('ATL') && add.includes('C)') && add.includes('drop Sexton') && add.includes('+21.5 FP'));
  assert.match(add, /\+\d+% win chance/);
  assert.ok(!text.includes('No add worth it today'));
  assert.ok(!/\p{Extended_Pictographic}/u.test(text));
  // one fact per line, no blank lines
  assert.ok(lines.every((l) => l.length > 0));
});

test('digest: fallbacks for no add, no injuries, a bye week and a missing win chance', () => {
  const fx = digestFixture();
  const noAdd = Object.assign({}, fx.vm, { recs: { byDay: { 9: [] }, note: null } });
  assert.ok(I.digest({ vm: noAdd, wp: fx.wp, trendRows: [], today: 9 }).split('\n').includes('No add worth it today'));
  const limited = Object.assign({}, fx.vm, { recs: { byDay: {}, note: 'You have used all 7 adds for this week.' } });
  const lt = I.digest({ vm: limited, wp: fx.wp, trendRows: [], today: 9 });
  assert.ok(lt.includes('No add worth it today') && lt.includes('used all 7 adds'));
  // healthy roster, no roles
  const healthy = Object.assign({}, fx.vm, { me: Object.assign({}, fx.vm.me, { rows: fx.vm.me.rows.slice(0, 1) }) });
  const h = I.digest({ vm: healthy, wp: fx.wp, trendRows: [], today: 9 }).split('\n');
  assert.ok(h.includes('Injuries: none'));
  assert.ok(h.includes('Role changes: none'));
  assert.ok(h.includes('Today: 1 of 1 players play'));
  // bye week
  const bye = Object.assign({}, fx.vm, { opp: null });
  const byeText = I.digest({ vm: bye, wp: { pWin: null, pTie: null, me: { mean: 1, sd: 1 }, opp: null }, trendRows: [], today: 9 });
  assert.ok(byeText.split('\n')[0].endsWith('Thanos was right 541.4, bye week'));
  assert.ok(byeText.includes('Win chance: no opponent this week'));
  assert.ok(!byeText.includes('Projected final'));
  // no wp: the line is left out; today defaults to the day marked "today"
  const nowp = I.digest({ vm: fx.vm, trendRows: [] });
  assert.ok(!nowp.includes('Win chance'));
  assert.ok(nowp.includes('Best add today: Jock Landale'));
  assert.ok(!/% win chance/.test(nowp));
  // a day outside the week still produces the add fallback
  const other = I.digest({ vm: fx.vm, wp: fx.wp, trendRows: [], today: 99 });
  assert.ok(other.includes('No add worth it today'));
  assert.ok(!other.includes('Today:'));
});

test('digest: works end-to-end on a real view model', () => {
  const vm = buildVm(false);
  const wp = I.winProbability(vm, { factors: null });
  const text = I.digest({ vm, wp, trendRows: [], today: 7 });
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('Week 2 · Oct 26 – Nov 1: Me 0.0, Opp 0.0'));
  assert.ok(lines.some((l) => /^Win chance: \d+%$/.test(l)));
  assert.ok(lines.includes('Today: 4 of 4 players play'));
  assert.ok(lines.includes('No add worth it today'));
});
