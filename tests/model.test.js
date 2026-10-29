'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../web/model.js');

/* ------------------------------------------------------------ dates */

test('etDate handles DST and the midnight-UTC edge', () => {
  // 2026-10-21 00:30 UTC is still Oct 20 in New York (EDT, UTC-4)
  assert.strictEqual(M.etDate(Date.UTC(2026, 9, 21, 0, 30)), '2026-10-20');
  assert.strictEqual(M.etDate(Date.UTC(2026, 9, 21, 4, 0)), '2026-10-21');
  assert.strictEqual(M.etDate(Date.UTC(2026, 9, 21, 3, 59)), '2026-10-20');
  // after DST ends (Nov 1 2026) the offset is UTC-5
  assert.strictEqual(M.etDate(Date.UTC(2026, 10, 2, 4, 59)), '2026-11-01');
  assert.strictEqual(M.etDate(Date.UTC(2026, 10, 2, 5, 0)), '2026-11-02');
  // spring forward (Mar 8 2026)
  assert.strictEqual(M.etDate(Date.UTC(2026, 2, 9, 3, 59)), '2026-03-08');
  assert.strictEqual(M.etDate(Date.UTC(2026, 2, 9, 4, 0)), '2026-03-09');
});

test('addDays / diffDays / weekdayOf are DST safe', () => {
  assert.strictEqual(M.addDays('2026-10-31', 2), '2026-11-02');
  assert.strictEqual(M.addDays('2026-03-01', 14), '2026-03-15');
  assert.strictEqual(M.addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(M.diffDays('2026-11-02', '2026-10-31'), 2);
  assert.strictEqual(M.diffDays('2026-03-10', '2026-03-01'), 9);
  assert.strictEqual(M.diffDays('2026-10-20', '2026-10-27'), -7);
  assert.strictEqual(M.weekdayOf('2026-10-20'), 2);
  assert.strictEqual(M.weekdayOf('2026-10-25'), 0);
});

test('fmtRange formats same-month and cross-month ranges', () => {
  assert.strictEqual(M.fmtRange('2026-10-26', '2026-11-01'), 'Oct 26 – Nov 1');
  assert.strictEqual(M.fmtRange('2027-02-15', '2027-02-28'), 'Feb 15 – 28');
});

/* ---------------------------------------------------- pro schedule */

function proRawFrom(games) {
  // games: [{id, sp, date, home, away}]
  const teams = {};
  for (let i = 1; i <= 4; i++) teams[i] = { id: i, abbrev: 'T' + i, location: 'Town' + i, name: 'Nick' + i, proGamesByScoringPeriod: {} };
  games.forEach((g) => {
    [g.home, g.away].forEach((t) => {
      (teams[t].proGamesByScoringPeriod[g.sp] = teams[t].proGamesByScoringPeriod[g.sp] || []).push({
        id: g.id, date: g.date, homeProTeamId: g.home, awayProTeamId: g.away, scoringPeriodId: g.sp, startTimeTBD: false,
      });
    });
  });
  return { settings: { proTeams: [{ id: 0, abbrev: 'FA', proGamesByScoringPeriod: {} }].concat(Object.values(teams)) } };
}
const tip = (sp, hourUtc) => Date.UTC(2026, 9, 20 + sp - 1, hourUtc === undefined ? 23 : hourUtc);

function plainSched(startDate) {
  // tiny hand-made sched for calendar helper tests
  return { startDate };
}

test('calendarWeekOf with a Tuesday start', () => {
  const s = plainSched('2026-10-20');
  assert.strictEqual(M.calendarWeekOf(s, 1), 1);
  assert.strictEqual(M.calendarWeekOf(s, 6), 1);
  assert.strictEqual(M.calendarWeekOf(s, 7), 2);
  assert.strictEqual(M.calendarWeekOf(s, 10), 2);
  assert.strictEqual(M.calendarWeekOf(s, 13), 2);
  assert.strictEqual(M.calendarWeekOf(s, 14), 3);
  assert.deepStrictEqual(M.calendarWeekSps(s, 1, 174), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(M.calendarWeekSps(s, 2, 174), [7, 8, 9, 10, 11, 12, 13]);
  assert.deepStrictEqual(M.calendarWeekSps(s, 25, 174), [168, 169, 170, 171, 172, 173, 174]);
  assert.deepStrictEqual(M.calendarWeekSps(s, 26, 174), []);
});

test('buildProSchedule derives startDate (mode), skips id 0, indexes games', () => {
  const raw = proRawFrom([
    { id: 1, sp: 1, date: tip(1), home: 1, away: 2 },
    { id: 2, sp: 1, date: tip(1, 1 + 24), home: 3, away: 4 }, // 01:00 UTC next day = still Oct 20 ET
    { id: 3, sp: 2, date: tip(2), home: 1, away: 3 },
  ]);
  const s = M.buildProSchedule(raw);
  assert.strictEqual(s.startDate, '2026-10-20');
  assert.strictEqual(s.teams[0], undefined);
  assert.strictEqual(Object.keys(s.games).length, 3);
  assert.strictEqual(s.gamesBySp[1].length, 2);
  assert.strictEqual(M.teamGame(s, 1, 2).id, 3);
  assert.strictEqual(M.teamGame(s, 2, 2), null);
  assert.strictEqual(M.spDate(s, 3), '2026-10-22');
  assert.strictEqual(M.dateSp(s, '2026-10-22'), 3);
  assert.strictEqual(s.games[1].home, 1);
  assert.strictEqual(s.games[1].away, 2);
});

/* ------------------------------------------------------- buildWeeks */

const MP = {};
for (let i = 1; i <= 20; i++) MP[String(i)] = [i];
MP['21'] = [21, 22];
MP['22'] = [23, 24];

test('buildWeeks with All-Star merge probe', () => {
  const probe = {};
  for (let i = 1; i <= 18; i++) probe[i] = i;
  probe[19] = 18; probe[20] = 19;
  const league = { matchupPeriods: MP, regularCount: 19, finalSp: 174 };
  const weeks = M.buildWeeks({ sched: plainSched('2026-10-20'), league, probe });
  const w = (id) => weeks.find((x) => x.id === id);
  assert.strictEqual(weeks.length, 22);
  assert.deepStrictEqual(w(1).calWeeks, [1]);
  assert.strictEqual(w(1).label, 'Week 1');
  assert.strictEqual(w(2).range, 'Oct 26 – Nov 1');
  assert.deepStrictEqual(w(18).calWeeks, [18, 19]);
  assert.strictEqual(w(18).sps.length, 14);
  assert.strictEqual(w(18).long, true);
  assert.strictEqual(w(17).long, false);
  assert.deepStrictEqual(w(19).calWeeks, [20]);
  assert.strictEqual(w(19).playoff, false);
  assert.deepStrictEqual(w(20).calWeeks, [21]);
  assert.strictEqual(w(20).playoff, true);
  assert.strictEqual(w(20).label, 'Playoffs · round 1');
  assert.deepStrictEqual(w(21).calWeeks, [22, 23]);
  assert.strictEqual(w(21).long, true);
  assert.deepStrictEqual(w(22).calWeeks, [24, 25]);
  assert.strictEqual(w(22).last, 174);
  assert.strictEqual(w(22).label, 'Playoffs · round 3');
  // weeks tile the season with no gaps
  for (let i = 1; i < weeks.length; i++) assert.strictEqual(weeks[i].first, weeks[i - 1].last + 1);
});

test('buildWeeks falls back to 1:1 with an empty probe', () => {
  const league = { matchupPeriods: MP, regularCount: 19, finalSp: 174 };
  const weeks = M.buildWeeks({ sched: plainSched('2026-10-20'), league, probe: {} });
  const w = (id) => weeks.find((x) => x.id === id);
  assert.deepStrictEqual(w(5).calWeeks, [5]);
  assert.deepStrictEqual(w(19).calWeeks, [19]);
  assert.deepStrictEqual(w(20).calWeeks, [20]);
  assert.deepStrictEqual(w(21).calWeeks, [21, 22]);
  assert.deepStrictEqual(w(22).calWeeks, [23, 24]);
  assert.ok(w(22).last <= 174);
});

/* ---------------------------------------------------------- players */

function stat(id, o) { return Object.assign({ id, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 0, appliedAverage: 0, stats: {} }, o); }
function gameEntry(sp, fp, box) {
  return stat('05' + sp, { statSplitTypeId: 5, scoringPeriodId: sp, appliedTotal: fp, stats: Object.assign({ 42: 1 }, box || {}) });
}
function seasonStats(season, o) {
  const out = [];
  if (o.cur) out.push(stat('00' + season, { appliedAverage: o.cur[0], appliedTotal: o.cur[0] * o.cur[1], stats: { 42: o.cur[1] } }));
  if (o.proj != null) out.push(stat('10' + season, { statSourceId: 1, appliedAverage: o.proj, stats: { 42: 70 } }));
  if (o.prev) out.push(stat('00' + (season - 1), { appliedAverage: o.prev[0], appliedTotal: o.prev[0] * o.prev[1], stats: { 42: o.prev[1] } }));
  if (o.l15) out.push(stat('02' + season, { appliedAverage: o.l15[0], appliedTotal: o.l15[0] * o.l15[1], stats: { 42: o.l15[1] } }));
  return out;
}
function rawPlayer(id, name, proTeamId, eligible, stats, injury) {
  const [first, ...rest] = name.split(' ');
  return { id, fullName: name, firstName: first, lastName: rest.join(' '), proTeamId, defaultPositionId: 1, eligibleSlots: eligible, injuryStatus: injury || 'ACTIVE', ownership: { percentOwned: 12.5, percentChange: 1.5 }, stats: stats || [] };
}

test('normPlayer: roster entry shape', () => {
  const p = M.normPlayer({ playerId: 5, lineupSlotId: 11, injuryStatus: 'DAY_TO_DAY', playerPoolEntry: { player: rawPlayer(5, 'Al Smith', 2, [3, 2, 6, 7, 11, 12, 13]) } });
  assert.strictEqual(p.id, 5);
  assert.strictEqual(p.name, 'Al Smith');
  assert.strictEqual(p.last, 'Smith');
  assert.strictEqual(p.pos, 'SF/PF');
  assert.strictEqual(p.slot, 11);
  assert.strictEqual(p.injury, 'DAY_TO_DAY');
  assert.strictEqual(p.status, 'ONTEAM');
  assert.strictEqual(p.waiverDate, null);
  assert.deepStrictEqual(p.own, { pct: 12.5, chg: 1.5 });
});

test('normPlayer: kona entry shape and pos ordering', () => {
  const p = M.normPlayer({ id: 9, status: 'WAIVERS', waiverProcessDate: 1234, player: rawPlayer(9, 'Bo Jones', 3, [4, 0, 3, 11, 12, 13]) });
  assert.strictEqual(p.id, 9);
  assert.strictEqual(p.pos, 'PG/PF/C');
  assert.strictEqual(p.slot, null);
  assert.strictEqual(p.status, 'WAIVERS');
  assert.strictEqual(p.waiverDate, 1234);
  assert.strictEqual(p.injury, 'ACTIVE');
});

test('gameStat and boxOf', () => {
  const p = M.normPlayer({ id: 1, status: 'FREEAGENT', player: rawPlayer(1, 'A B', 1, [0], [gameEntry(7, 33.5, { 0: 20, 6: 5, 3: 7, 2: 1, 1: 2, 11: 3, 40: 31, 13: 8, 14: 15, 17: 2 })]) });
  assert.strictEqual(M.gameStat(p, 8), null);
  const g = M.gameStat(p, 7);
  assert.strictEqual(g.appliedTotal, 33.5);
  assert.deepStrictEqual(M.boxOf(g), { pts: 20, reb: 5, ast: 7, stl: 1, blk: 2, to: 3, min: 31, fgm: 8, fga: 15, tpm: 2 });
});

test('projectPlayer blends current with prior', () => {
  const n = (stats) => M.normPlayer({ id: 1, status: 'FREEAGENT', player: rawPlayer(1, 'A B', 1, [0], stats) });
  // current 40 over 10 GP, prior 30 -> half/half
  let pr = M.projectPlayer(n(seasonStats(2027, { cur: [40, 10], proj: 30 })), 2027);
  assert.ok(Math.abs(pr.fp - 35) < 1e-9);
  assert.strictEqual(pr.n, 10);
  assert.strictEqual(pr.espnProj, 30);
  // no prior at all -> current avg
  pr = M.projectPlayer(n(seasonStats(2027, { cur: [22, 4] })), 2027);
  assert.ok(Math.abs(pr.fp - 22) < 1e-9);
  // falls back to last season when no projection
  pr = M.projectPlayer(n(seasonStats(2027, { prev: [18, 60] })), 2027);
  assert.ok(Math.abs(pr.fp - 18) < 1e-9);
  assert.strictEqual(pr.prevAvg, 18);
  // no current -> prior
  pr = M.projectPlayer(n(seasonStats(2027, { proj: 27 })), 2027);
  assert.strictEqual(pr.fp, 27);
  assert.strictEqual(pr.curAvg, null);
  // no prior, no current, only l15
  pr = M.projectPlayer(n(seasonStats(2027, { l15: [12, 5] })), 2027);
  assert.strictEqual(pr.fp, 12);
  assert.strictEqual(pr.l15n, 5);
  // nothing -> 0
  assert.strictEqual(M.projectPlayer(n([]), 2027).fp, 0);
  // average derived from total when appliedAverage missing
  pr = M.projectPlayer(n([stat('002027', { appliedTotal: 100, stats: { 42: 4 } })]), 2027);
  assert.strictEqual(pr.curAvg, 25);
  // non-points league
  assert.strictEqual(M.projectPlayer(n(seasonStats(2027, { proj: 30 })), 2027, false).fp, 1);
});

/* ------------------------------------------------------- bestLineup */

const cand = (key, w, slots) => ({ key, w, slots });

test('bestLineup respects position caps and UTIL', () => {
  const C = [4, 11, 12, 13];
  const cands = [cand('c1', 50, C), cand('c2', 40, C), cand('c3', 30, C), cand('pg', 10, [0, 11, 12, 13])];
  const r = M.bestLineup(cands, { 0: 1, 4: 1, 11: 1 });
  assert.deepStrictEqual(r.chosen.map((c) => c.key).sort(), ['c1', 'c2', 'pg']);
  assert.strictEqual(r.total, 100);
  assert.deepStrictEqual([r.slotOf.get('c1'), r.slotOf.get('c2')].sort((a, b) => a - b), [4, 11]);
  assert.strictEqual(r.slotOf.get('pg'), 0);
  assert.ok(!r.slotOf.has('c3'));
});

test('bestLineup never picks bench/IR-only players and handles empties', () => {
  const r = M.bestLineup([cand('b', 99, [12, 13]), cand('x', 1, [0, 12])], { 0: 1, 11: 1 });
  assert.deepStrictEqual(r.chosen.map((c) => c.key), ['x']);
  const e = M.bestLineup([], { 0: 1 });
  assert.strictEqual(e.total, 0);
  assert.strictEqual(e.chosen.length, 0);
});

test('bestLineup augmenting paths beat naive slot assignment', () => {
  // A (w10) fits PG or UTIL; B (w9) fits only PG; C (w8) fits only UTIL.
  // A grabs PG first; B must push A to UTIL, which in turn leaves C out.
  const cands = [cand('A', 10, [0, 11]), cand('B', 9, [0]), cand('C', 8, [11])];
  const r = M.bestLineup(cands, { 0: 1, 11: 1 });
  assert.deepStrictEqual(r.chosen.map((c) => c.key).sort(), ['A', 'B']);
  assert.strictEqual(r.total, 19);
  assert.strictEqual(r.slotOf.get('B'), 0);
  assert.strictEqual(r.slotOf.get('A'), 11);
  // max cardinality: low-weight player that only fits PG still ends in lineup when it adds a body
  const r2 = M.bestLineup([cand('A', 10, [0, 11]), cand('B', 1, [0])], { 0: 1, 11: 1 });
  assert.strictEqual(r2.chosen.length, 2);
  assert.strictEqual(r2.total, 11);
});

test('bestLineup is fast for a realistic recommendation load', () => {
  const slots = [[0, 5, 11], [1, 5, 11], [2, 6, 11], [3, 6, 11], [4, 11], [0, 1, 5, 11], [2, 3, 6, 11]];
  const cands = [];
  for (let i = 0; i < 15; i++) cands.push(cand('p' + i, 40 - i, slots[i % slots.length]));
  const caps = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 3 };
  const t0 = Date.now();
  for (let i = 0; i < 5000; i++) M.bestLineup(cands, caps);
  assert.ok(Date.now() - t0 < 1000);
});

/* ------------------------------------------------------ normLeague */

test('normLeague and detectMyTeam', () => {
  const raw = {
    id: 1257343892, seasonId: 2027, scoringPeriodId: 9,
    settings: {
      name: 'Test League', size: 2,
      scoringSettings: { scoringType: 'H2H_POINTS' },
      rosterSettings: { lineupSlotCounts: { 0: 1, 1: 0, 4: 1, 11: 2, 12: 3, 13: 1 } },
      acquisitionSettings: { matchupAcquisitionLimit: 1, matchupLimitPerScoringPeriod: true },
      scheduleSettings: { matchupPeriodCount: 19, matchupPeriods: MP },
    },
    status: { latestScoringPeriod: 9, currentMatchupPeriod: 2, finalScoringPeriod: 174 },
    teams: [
      { id: 6, name: ' Thanos was right ', abbrev: 'THAN', owners: ['{ABC-123}'], record: { overall: { wins: 1, losses: 2, ties: 0 } }, transactionCounter: { matchupAcquisitionTotals: { 2: 3 } } },
      { id: 4, location: 'Lebron', nickname: 'ocracy', abbrev: 'LEB', owners: ['{DEF-456}'] },
    ],
    schedule: [{ matchupPeriodId: 2, home: { teamId: 6, totalPoints: 10, pointsByScoringPeriod: { 7: 10 } }, away: { teamId: 4, totalPoints: 5 } }],
  };
  const L = M.normLeague(raw);
  assert.deepStrictEqual(L.caps, { 0: 1, 4: 1, 11: 2 });
  assert.strictEqual(L.starters, 4);
  assert.strictEqual(L.benchCount, 3);
  assert.strictEqual(L.irCount, 1);
  assert.deepStrictEqual(L.acq, { limit: 1, perDay: true });
  assert.strictEqual(L.isPoints, true);
  assert.strictEqual(L.currentSp, 9);
  assert.strictEqual(L.currentMp, 2);
  assert.strictEqual(L.finalSp, 174);
  assert.strictEqual(L.regularCount, 19);
  assert.strictEqual(L.teams[6].name, 'Thanos was right');
  assert.strictEqual(L.teams[4].name, 'Lebron ocracy');
  assert.deepStrictEqual(L.teams[6].addsByMp, { 2: 3 });
  assert.strictEqual(L.matchups[0].home.total, 10);
  assert.strictEqual(L.matchups[0].home.bySp[7], 10);
  assert.strictEqual(M.detectMyTeam(L, 'abc-123'), 6);
  assert.strictEqual(M.detectMyTeam(L, '{def-456}'), 4);
  assert.strictEqual(M.detectMyTeam(L, '{nope}'), null);
  // schedRaw overrides leagueRaw.schedule
  const L2 = M.normLeague(raw, { schedule: [] });
  assert.strictEqual(L2.matchups.length, 0);
});

/* ------------------------------------------------------ computeWeek */

/*
 Synthetic league. Week 2 = sps 7..13 (Mon Oct 26 - Sun Nov 1). Today = sp 9.
 Pro teams 1..4. Games:
   sp7: 1v2, 3v4     sp8: 1v3       sp9: 2v4       sp10: 1v4
   sp11: 4v2         sp12, sp13: none
 Slots: PG x1, C x1, UTIL x2 (4 starters), 3 bench, 1 IR.
*/
const GAMES = [
  { id: 101, sp: 7, date: tip(7), home: 1, away: 2 }, { id: 102, sp: 7, date: tip(7), home: 3, away: 4 },
  { id: 103, sp: 8, date: tip(8), home: 1, away: 3 },
  { id: 104, sp: 9, date: tip(9), home: 2, away: 4 },
  { id: 105, sp: 10, date: tip(10), home: 1, away: 4 },
  { id: 106, sp: 11, date: tip(11), home: 4, away: 2 },
];
const NOW_BEFORE = Date.UTC(2026, 9, 28, 20, 0); // Wed 4pm ET, tips at 7pm ET
const TIP9 = tip(9);
const NOW_AFTER = TIP9 + 3600 * 1000; // one hour after tip

const PG = [0, 5, 11, 12, 13];
const CE = [4, 9, 11, 12, 13];

function rosterEntry(id, name, team, elig, slot, projFp, extra) {
  extra = extra || {};
  const stats = seasonStats(2027, { proj: projFp }).concat(extra.stats || []);
  return { playerId: id, lineupSlotId: slot, injuryStatus: extra.injury || 'ACTIVE', playerPoolEntry: { player: rawPlayer(id, name, team, elig, stats, extra.injury) } };
}

function buildCtx(opts) {
  opts = opts || {};
  const league = M.normLeague({
    id: 1, seasonId: 2027,
    settings: {
      name: 'T', size: 2, scoringSettings: { scoringType: 'H2H_POINTS' },
      rosterSettings: { lineupSlotCounts: { 0: 1, 4: 1, 11: 2, 12: 3, 13: 1 } },
      acquisitionSettings: { matchupAcquisitionLimit: 1, matchupLimitPerScoringPeriod: true },
      scheduleSettings: { matchupPeriodCount: 19, matchupPeriods: MP },
    },
    status: { latestScoringPeriod: 9, currentMatchupPeriod: 2, finalScoringPeriod: 174 },
    teams: [{ id: 6, name: 'Me', abbrev: 'ME' }, { id: 4, name: 'Opp', abbrev: 'OPP' }],
    schedule: [
      { matchupPeriodId: 1, home: { teamId: 6, totalPoints: 0 }, away: { teamId: 4, totalPoints: 0 } },
      { matchupPeriodId: 2, home: { teamId: 6, totalPoints: 165, pointsByScoringPeriod: { 7: 140, 8: 25 } }, away: { teamId: 4, totalPoints: 70, pointsByScoringPeriod: { 7: 60, 8: 10 } } },
    ],
  });
  const sched = M.buildProSchedule(proRawFrom(GAMES));
  const week = M.buildWeeks({ sched, league: Object.assign({}, league, { finalSp: 174 }), probe: { 2: 2 } }).find((w) => w.id === 2);
  const N = (e) => M.normPlayer(e);

  // my team, current
  const p1 = rosterEntry(1, 'Pat One', 1, PG, 0, 30);
  const p2 = rosterEntry(2, 'Cal Two', 1, CE, 4, 40, { injury: 'OUT' });
  const p3 = rosterEntry(3, 'Cy Three', 2, CE, 11, 35);
  const p4 = rosterEntry(4, 'Pete Four', 3, PG, 11, 20, { stats: [gameEntry(7, 25, { 0: 12 })] });
  const p5 = rosterEntry(5, 'Ben Five', 4, PG, 12, 10);
  const p6 = rosterEntry(6, 'Ira Six', 2, PG, 13, 25, { injury: 'OUT' });
  const p7 = rosterEntry(7, 'Bo Seven', 1, PG, 12, 5);
  const p8 = rosterEntry(8, 'Bob Eight', 4, PG, 12, 8);
  const cur = [p1, p2, p3, p4, p5, p6, p7, p8].map(N);
  const withStats = (e, ...games) => Object.assign({}, e, {
    playerPoolEntry: { player: Object.assign({}, e.playerPoolEntry.player, { stats: e.playerPoolEntry.player.stats.concat(games) }) },
  });
  const g99 = rosterEntry(99, 'Gil Gone', 3, PG, 11, 15, { stats: [gameEntry(7, 20, { 0: 9 })] });
  const bySp7 = [
    withStats(p1, gameEntry(7, 40, { 0: 25, 6: 4, 3: 6, 40: 33 })), withStats(p2, gameEntry(7, 50)), withStats(p3, gameEntry(7, 30)),
    g99, withStats(p5, gameEntry(7, 12)), p6, p7, p8,
  ].map(N);
  const bySp8 = [withStats(p1, gameEntry(8, 10)), p2, p3, withStats(p4, gameEntry(8, 15)), p5, p6, p7, p8].map(N);
  let bySp9 = [p1, p2, p3, p4, p5, p6, p7, p8];
  if (opts.after) bySp9 = [p1, p2, withStats(p3, gameEntry(9, 18)), p4, p5, p6, p7, p8];
  bySp9 = bySp9.map(N);
  const curNow = opts.after ? [p1, p2, withStats(p3, gameEntry(9, 18)), p4, p5, p6, p7, p8].map(N) : cur;

  // opponent
  const q1 = rosterEntry(21, 'Quin One', 1, PG, 0, 20);
  const q2 = rosterEntry(22, 'Quad Two', 3, CE, 4, 20);
  const oppCur = [q1, q2].map(N);
  const oppBy7 = [withStats(q1, gameEntry(7, 25)), withStats(q2, gameEntry(7, 35))].map(N);
  const oppBy8 = [withStats(q1, gameEntry(8, 10)), q2].map(N);
  const oppBy9 = [q1, q2].map(N);

  const fa = (id, name, team, elig, fp, status, waiverDate, own) => M.normPlayer({
    id, status, waiverProcessDate: waiverDate, player: Object.assign(rawPlayer(id, name, team, elig, seasonStats(2027, { proj: fp })), { ownership: { percentOwned: own || 3, percentChange: 0 } }),
  });
  // waiver clears Oct 30 early morning ET = sp 11
  const waiverMs = Date.UTC(2026, 9, 30, 8, 0);
  const freeAgents = [
    fa(201, 'Cee Free', 4, CE, 20, 'FREEAGENT', null),
    fa(202, 'Wave Waiver', 4, CE, 25, 'WAIVERS', waiverMs),
    fa(203, 'Hurt Free', 4, CE, 50, 'FREEAGENT', null),
    fa(204, 'Idle Free', 5, CE, 50, 'FREEAGENT', null), // team with no game
  ];
  freeAgents[2].injury = 'OUT';

  const transactions = [
    { teamId: 6, type: 'FREEAGENT', status: 'EXECUTED', scoringPeriodId: 8, items: [{ type: 'ADD', playerId: 4 }, { type: 'DROP', playerId: 99 }] },
    { teamId: 6, type: 'FREEAGENT', status: 'EXECUTED', scoringPeriodId: 9, items: [{ type: 'ADD', playerId: 5 }, { type: 'DROP', playerId: 50 }] },
    { teamId: 4, type: 'FREEAGENT', status: 'EXECUTED', scoringPeriodId: 9, items: [{ type: 'ADD', playerId: 22 }] },
    { teamId: 6, type: 'WAIVER', status: 'PENDING', scoringPeriodId: 9, items: [{ type: 'ADD', playerId: 202 }, { type: 'DROP', playerId: 7 }] },
    { teamId: 6, type: 'FREEAGENT', status: 'CANCELED', scoringPeriodId: 9, items: [{ type: 'ADD', playerId: 201 }] },
    { teamId: 6, type: 'ROSTER', status: 'EXECUTED', scoringPeriodId: 9, items: [{ type: 'LINEUP', playerId: 1 }] },
    { teamId: 6, type: 'FREEAGENT', status: 'EXECUTED', scoringPeriodId: 3, items: [{ type: 'ADD', playerId: 8 }] }, // other week
  ];

  return {
    league, sched, week, now: opts.after ? NOW_AFTER : NOW_BEFORE, myTeamId: 6,
    rosters: {
      6: { current: curNow, bySp: { 7: bySp7, 8: bySp8, 9: bySp9 } },
      4: { current: oppCur, bySp: { 7: oppBy7, 8: oppBy8, 9: oppBy9 } },
    },
    freeAgents: opts.noFa ? [] : freeAgents,
    transactions: opts.noTx ? [] : transactions,
  };
}

const rowOf = (tw, id) => tw.rows.find((r) => r.player.id === id);

test('computeWeek: days, opponent, games per team', () => {
  const vm = M.computeWeek(buildCtx());
  assert.strictEqual(vm.isPoints, true);
  assert.deepStrictEqual(vm.days.map((d) => d.sp), [7, 8, 9, 10, 11, 12, 13]);
  assert.deepStrictEqual(vm.days.map((d) => d.kind), ['past', 'past', 'today', 'future', 'future', 'future', 'future']);
  assert.strictEqual(vm.days[0].dow, 'Mon');
  assert.strictEqual(vm.days[0].dom, 26);
  assert.strictEqual(vm.days[6].dow, 'Sun');
  assert.strictEqual(vm.days[0].nGames, 2);
  assert.strictEqual(vm.days[3].nGames, 1);
  assert.strictEqual(vm.days[3].light, true);
  assert.strictEqual(vm.days[0].firstTip, tip(7));
  assert.strictEqual(vm.opp.teamId, 4);
  assert.strictEqual(vm.opp.name, 'Opp');
  assert.strictEqual(vm.me.name, 'Me');
  // team 1: sp7, sp8, sp10 = 3; team 2: sp7, sp9, sp11 = 3; team 3: 7, 8 = 2; team 4: 7, 9, 10, 11 = 4
  const g = Object.fromEntries(vm.gamesPerTeam.map((x) => [x.count, x.teams.map((t) => t.abbrev)]));
  assert.deepStrictEqual(g[4], ['T4']);
  assert.deepStrictEqual(g[3], ['T1', 'T2']);
  assert.deepStrictEqual(g[2], ['T3']);
  assert.deepStrictEqual(vm.gamesPerTeam.map((x) => x.count), [4, 3, 2]);
});

test('computeWeek: no opponent when the matchup is missing', () => {
  const ctx = buildCtx();
  ctx.week = Object.assign({}, ctx.week, { id: 3 });
  const vm = M.computeWeek(ctx);
  assert.strictEqual(vm.opp, null);
});

test('computeWeek: past days count only played active-slot players', () => {
  const vm = M.computeWeek(buildCtx());
  const d7 = vm.me.days[7], d8 = vm.me.days[8];
  assert.strictEqual(d7.played, 4); // p1, p2, p3, gone player; bench p5 and IR p6 do not count
  assert.strictEqual(d7.playedPts, 140);
  assert.strictEqual(d7.open, null);
  assert.strictEqual(d8.played, 2); // p1 and p4; p2 DNP
  assert.strictEqual(d8.playedPts, 25);
  assert.strictEqual(vm.me.actual, 165);
  const r1 = rowOf(vm.me, 1);
  assert.strictEqual(r1.cells[7].t, 'played');
  assert.strictEqual(r1.cells[7].fp, 40);
  assert.strictEqual(r1.cells[7].counted, true);
  assert.strictEqual(r1.cells[7].why, null);
  assert.strictEqual(r1.cells[7].opp, 'T2');
  assert.strictEqual(r1.cells[7].home, true);
  assert.strictEqual(r1.cells[7].live, false);
  assert.strictEqual(r1.cells[7].box.pts, 25);
  assert.strictEqual(r1.soFar, 50);
  // bench player who played
  const r5 = rowOf(vm.me, 5);
  assert.strictEqual(r5.cells[7].counted, false);
  assert.strictEqual(r5.cells[7].why, 'bench');
  assert.strictEqual(r5.cells[7].home, false);
  assert.strictEqual(r5.cells[7].opp, 'T3');
  // IR + out + no stat
  const r6 = rowOf(vm.me, 6);
  assert.strictEqual(r6.cells[7].t, 'dnp');
  assert.strictEqual(r6.cells[7].why, 'out');
  // did not play, healthy
  assert.strictEqual(rowOf(vm.me, 2).cells[8].t, 'dnp');
  assert.strictEqual(rowOf(vm.me, 7).cells[8].why, 'dnp');
  // acquired later: team played but he was not on the roster
  const r4 = rowOf(vm.me, 4);
  assert.strictEqual(r4.cells[7].t, 'played');
  assert.strictEqual(r4.cells[7].why, 'away');
  assert.strictEqual(r4.cells[7].counted, false);
  assert.strictEqual(r4.cells[7].fp, 25);
  assert.strictEqual(r4.cells[8].counted, true);
  assert.strictEqual(r4.soFar, 15);
});

test('computeWeek: gone rows and row ordering', () => {
  const vm = M.computeWeek(buildCtx());
  const ids = vm.me.rows.map((r) => r.player.id);
  assert.deepStrictEqual(ids.slice(0, 2), [1, 2]); // PG slot then C slot
  assert.deepStrictEqual(ids.slice(2, 4).sort(), [3, 4]); // UTIL
  assert.strictEqual(ids[ids.length - 1], 99);
  assert.strictEqual(ids[ids.length - 2], 6); // IR before gone
  const gone = rowOf(vm.me, 99);
  assert.strictEqual(gone.gone, true);
  assert.strictEqual(gone.cells[7].counted, true);
  assert.strictEqual(gone.total, 20);
  assert.strictEqual(rowOf(vm.me, 1).gone, false);
  assert.strictEqual(vm.me.rows.length, 9);
});

test('computeWeek: today before tip is optimised like a future day', () => {
  const vm = M.computeWeek(buildCtx());
  const d9 = vm.me.days[9];
  // team 2 (p3, IR p6) and team 4 (p5, p8) play; p6 is IR so not a candidate
  assert.strictEqual(d9.played, 0);
  assert.strictEqual(d9.remaining, 3);
  assert.strictEqual(d9.withGame, 3);
  assert.strictEqual(d9.open, 1);
  assert.ok(Math.abs(d9.remProj - (35 + 10 + 8)) < 1e-9);
  const c = rowOf(vm.me, 3).cells[9];
  assert.strictEqual(c.t, 'proj');
  assert.strictEqual(c.start, true);
  assert.strictEqual(c.opp, 'T4');
  assert.strictEqual(c.home, true);
  assert.strictEqual(c.tip, TIP9);
  assert.strictEqual(rowOf(vm.me, 6).cells[9].out, true);
  assert.strictEqual(rowOf(vm.me, 6).cells[9].start, false);
});

test('computeWeek: started games today count and consume caps', () => {
  const vm = M.computeWeek(buildCtx({ after: true }));
  const d9 = vm.me.days[9];
  assert.strictEqual(d9.played, 1); // p3 in UTIL (has a stat); bench p5/p8 do not count
  assert.strictEqual(d9.playedPts, 18);
  const c3 = rowOf(vm.me, 3).cells[9];
  assert.strictEqual(c3.t, 'played');
  assert.strictEqual(c3.counted, true);
  assert.strictEqual(c3.live, true);
  assert.strictEqual(rowOf(vm.me, 5).cells[9].t, 'dnp'); // started, no stat, bench
  assert.strictEqual(d9.remaining, 0); // team 4 games started too
  assert.strictEqual(vm.recs.byDay[9].length, 0);
});

test('computeWeek: started game with no stat yet counts for an active healthy player', () => {
  const ctx = buildCtx({ after: true });
  // strip the stat from p3 and keep him in his UTIL slot
  const strip = (p) => Object.assign({}, p, { stats: [] });
  ctx.rosters[6].current = ctx.rosters[6].current.map((p) => (p.id === 3 ? strip(p) : p));
  ctx.rosters[6].bySp[9] = ctx.rosters[6].bySp[9].map((p) => (p.id === 3 ? strip(p) : p));
  const vm = M.computeWeek(ctx);
  assert.strictEqual(vm.me.days[9].played, 1);
  assert.strictEqual(rowOf(vm.me, 3).cells[9].counted, true);
  // ruled out: does not count
  ctx.rosters[6].bySp[9] = ctx.rosters[6].bySp[9].map((p) => (p.id === 3 ? Object.assign({}, p, { injury: 'OUT' }) : p));
  const vm2 = M.computeWeek(ctx);
  assert.strictEqual(vm2.me.days[9].played, 0);
  assert.strictEqual(rowOf(vm2.me, 3).cells[9].t, 'dnp');
});

test('computeWeek: future days exclude OUT players and squeeze extras', () => {
  const vm = M.computeWeek(buildCtx());
  // sp10: team 1 and 4 play. p2 (OUT), p1, p5, p7, p8 -> PG-eligibles only; slots PG + 2 UTIL
  const d10 = vm.me.days[10];
  assert.strictEqual(d10.remaining, 3);
  assert.strictEqual(d10.open, 1);
  assert.strictEqual(d10.withGame, 5); // p1 p2 p5 p7 p8 (IR excluded, none here)
  const cell = (id) => rowOf(vm.me, id).cells[10];
  assert.strictEqual(cell(2).out, true);
  assert.strictEqual(cell(2).start, false);
  assert.strictEqual(cell(1).start, true);
  assert.strictEqual(cell(5).start, true);
  assert.strictEqual(cell(8).start, true);
  assert.strictEqual(cell(7).start, false); // squeezed: lowest projection
  assert.strictEqual(cell(7).out, false);
  assert.ok(Math.abs(d10.remProj - (30 + 10 + 8)) < 1e-9);
  // no games for anyone on sp12/13
  assert.strictEqual(vm.me.days[12].remaining, 0);
  assert.strictEqual(vm.me.days[12].open, 4);
  assert.strictEqual(rowOf(vm.me, 1).cells[12], undefined);
});

test('computeWeek: team totals and projection', () => {
  const vm = M.computeWeek(buildCtx());
  assert.strictEqual(vm.me.played, 6);
  assert.strictEqual(vm.me.remaining, 3 + 3 + 3);
  assert.strictEqual(vm.me.total, vm.me.played + vm.me.remaining);
  const rem = (35 + 10 + 8) + (30 + 10 + 8);
  // sp11: team 4 + 2 play -> p3 (35), p5 (10), p8 (8)
  const sp11 = 35 + 10 + 8;
  assert.ok(Math.abs(vm.me.remProj - (rem + sp11)) < 1e-9);
  assert.ok(Math.abs(vm.me.projFinal - (165 + rem + sp11)) < 1e-9);
  // opponent
  assert.strictEqual(vm.opp.days[7].played, 2);
  assert.strictEqual(vm.opp.days[8].played, 1);
  assert.strictEqual(vm.opp.actual, 70);
  assert.strictEqual(vm.opp.played, 3);
  // row sums
  const r1 = rowOf(vm.me, 1);
  assert.ok(Math.abs(r1.total - (50 + 30)) < 1e-9); // 40+10 played, sp10 projected 30
  assert.strictEqual(r1.games, 3);
  assert.strictEqual(r1.proj.fp, 30);
});

test('computeWeek: adds from transactions', () => {
  const vm = M.computeWeek(buildCtx());
  assert.strictEqual(vm.adds.used, 2);
  assert.strictEqual(vm.adds.todayUsed, 1);
  assert.strictEqual(vm.adds.perDay, true);
  assert.strictEqual(vm.adds.limit, 1);
  assert.strictEqual(vm.adds.weekLimit, 7);
  assert.strictEqual(vm.adds.pending.length, 1);
  assert.deepStrictEqual(vm.adds.pending[0].add, { id: 202, name: 'Wave Waiver' });
  assert.deepStrictEqual(vm.adds.pending[0].drop, { id: 7, name: 'Bo Seven' });
  const vm2 = M.computeWeek(buildCtx({ noTx: true }));
  assert.strictEqual(vm2.adds.used, 0);
  assert.strictEqual(vm2.adds.todayUsed, 0);
  assert.deepStrictEqual(vm2.adds.pending, []);
});

test('computeWeek: recommendations fill open slots and respect waivers / daily limit', () => {
  const vm = M.computeWeek(buildCtx());
  // today's add already used -> no rec for today
  assert.deepStrictEqual(vm.recs.byDay[9], []);
  const r10 = vm.recs.byDay[10];
  assert.ok(r10.length >= 1);
  assert.strictEqual(r10[0].fa.id, 201);
  assert.ok(r10[0].gain > 0.5);
  assert.strictEqual(r10[0].sp, 10);
  assert.strictEqual(r10[0].waiver, false);
  assert.ok(r10[0].gamesReach >= 1);
  assert.strictEqual(r10[0].gamesLost, 0);
  assert.strictEqual(r10[0].upgrade, true);
  assert.strictEqual(r10[0].drop.id, 7); // squeezed player costs nothing to drop
  // gain from sp10: fills open C slot on sp10 (+20) and an open slot on sp11 (+20)
  assert.ok(Math.abs(r10[0].gain - 40) < 1e-9);
  assert.strictEqual(r10[0].faProj.fp, 20);
  assert.strictEqual(r10[0].dropProj.fp, 5);
  // OUT and no-game free agents never appear
  const all = [].concat(...Object.values(vm.recs.byDay)).map((r) => r.fa.id);
  assert.ok(!all.includes(203));
  assert.ok(!all.includes(204));
  // waiver player becomes available Oct 30 = sp 11
  assert.ok(!vm.recs.byDay[10].some((r) => r.fa.id === 202));
  const w11 = vm.recs.byDay[11].find((r) => r.fa.id === 202);
  assert.ok(w11);
  assert.strictEqual(w11.waiver, true);
  assert.ok(w11.gain > 0.5);
  assert.deepStrictEqual(vm.recs.byDay[11].map((r) => r.gain), vm.recs.byDay[11].map((r) => r.gain).slice().sort((a, b) => b - a));
  // board
  const b = vm.recs.board;
  assert.ok(b.length >= 2);
  const b201 = b.find((x) => x.fa.id === 201);
  assert.strictEqual(b201.bestSp, 10);
  assert.strictEqual(b201.gamesLeft, 3); // sp9 (unstarted), 10, 11
  assert.deepStrictEqual(b201.days, { 10: 'start', 11: 'start' });
  const b202 = b.find((x) => x.fa.id === 202);
  assert.strictEqual(b202.bestSp, 11);
  assert.deepStrictEqual(b202.days, { 11: 'start' });
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].gain >= b[i].gain);
});

test('computeWeek: with today\'s add unused, today can be recommended', () => {
  const ctx = buildCtx({ noTx: true });
  const vm = M.computeWeek(ctx);
  const r9 = vm.recs.byDay[9];
  assert.ok(r9.length >= 1);
  // sp9 team 4 plays; open slot (1 open) filled by 201 (C-eligible)
  assert.ok(r9.some((r) => r.fa.id === 201));
  assert.ok(r9.every((r) => r.gain > 0.5));
});

test('computeWeek: no free agents means no recommendations; past weeks have none', () => {
  const vm = M.computeWeek(buildCtx({ noFa: true }));
  assert.deepStrictEqual(vm.recs.board, []);
  assert.ok(Object.values(vm.recs.byDay).every((a) => a.length === 0));
  const ctx = buildCtx();
  ctx.league = Object.assign({}, ctx.league, { currentSp: 40 });
  ctx.now = Date.UTC(2026, 11, 1);
  const past = M.computeWeek(ctx);
  assert.deepStrictEqual(past.recs.byDay, {});
  assert.deepStrictEqual(past.recs.board, []);
  assert.ok(past.days.every((d) => d.kind === 'past'));
});

test('computeWeek: weekly add limit exhausted yields a note and no recs', () => {
  const ctx = buildCtx({ noTx: true });
  ctx.league = Object.assign({}, ctx.league, { acq: { limit: 2, perDay: false } });
  ctx.transactions = [
    { teamId: 6, type: 'FREEAGENT', status: 'EXECUTED', scoringPeriodId: 7, items: [{ type: 'ADD', playerId: 1 }] },
    { teamId: 6, type: 'WAIVER', status: 'EXECUTED', scoringPeriodId: 8, items: [{ type: 'ADD', playerId: 2 }] },
  ];
  const vm = M.computeWeek(ctx);
  assert.strictEqual(vm.adds.weekLimit, 2);
  assert.strictEqual(vm.adds.used, 2);
  assert.ok(vm.recs.note);
  assert.deepStrictEqual(vm.recs.board, []);
});

test('computeWeek: recommendation search over 80 free agents is fast', () => {
  const ctx = buildCtx({ noTx: true });
  const fas = [];
  for (let i = 0; i < 120; i++) {
    fas.push(M.normPlayer({ id: 1000 + i, status: 'FREEAGENT', player: rawPlayer(1000 + i, 'Free ' + i, 1 + (i % 4), i % 2 ? CE : PG, seasonStats(2027, { proj: 10 + (i % 17) })) }));
  }
  ctx.freeAgents = fas;
  const t0 = Date.now();
  const vm = M.computeWeek(ctx);
  assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
  assert.ok(vm.recs.board.length <= 25);
});

test('computeWeek: game factors adjust future projections by venue and back-to-back', () => {
  const plain = M.computeWeek(buildCtx());
  const ctx = buildCtx();
  ctx.factors = { home: 1.1, away: 0.9, b2bOutput: 1, b2bPlay: 0.5, opp: {} };
  const vm = M.computeWeek(ctx);
  let b2bSeen = 0;
  vm.me.rows.forEach((r) => {
    Object.keys(r.cells).forEach((k) => {
      const sp = +k, c = r.cells[k];
      if (c.t !== 'proj') return;
      const b2b = !!M.teamGame(ctx.sched, r.player.proTeamId, sp - 1);
      const want = r.proj.fp * (c.home ? 1.1 : 0.9) * (b2b ? 0.5 : 1);
      assert.ok(Math.abs(c.fp - want) < 1e-9, 'cell ' + r.player.id + '@' + sp);
      assert.strictEqual(c.b2b, b2b);
      if (b2b) b2bSeen++;
    });
  });
  assert.ok(b2bSeen > 0, 'fixture should contain a back-to-back');
  assert.notStrictEqual(vm.me.remProj, plain.me.remProj);
  // remaining game counts do not depend on the factors
  assert.strictEqual(vm.me.remaining, plain.me.remaining);
});

test('computeWeek: game factors are ignored in category leagues', () => {
  const ctx = buildCtx();
  ctx.league = Object.assign({}, ctx.league, { isPoints: false });
  const a = M.computeWeek(ctx);
  ctx.factors = { home: 1.1, away: 0.9, b2bOutput: 1, b2bPlay: 0.5, opp: {} };
  const b = M.computeWeek(ctx);
  assert.strictEqual(a.me.remProj, b.me.remProj);
});

test('factors.js has sane values for every team', () => {
  const F = require('../web/factors.js');
  assert.strictEqual(Object.keys(F.opp).length, 30);
  Object.values(F.opp).forEach((v) => assert.ok(v > 0.8 && v < 1.2));
  assert.ok(F.home > 1 && F.away < 1);
  assert.ok(F.b2bPlay > 0.7 && F.b2bPlay < 1);
  assert.ok(F.b2bOutput > 0.9 && F.b2bOutput < 1.1);
});

test('normPlayer: live ESPN roster entry says NORMAL, the player carries the status', () => {
  const out = M.normPlayer({ playerId: 7, lineupSlotId: 13, injuryStatus: 'NORMAL', playerPoolEntry: { player: rawPlayer(7, 'Jay Doe', 8, [4, 9, 10, 11, 12, 13], [], 'OUT') } });
  assert.strictEqual(out.injury, 'OUT');
  const dtd = M.normPlayer({ playerId: 8, lineupSlotId: 1, injuryStatus: 'NORMAL', playerPoolEntry: { player: rawPlayer(8, 'Kay Doe', 8, [1, 5, 11, 12, 13], [], 'DAY_TO_DAY') } });
  assert.strictEqual(dtd.injury, 'DAY_TO_DAY');
  const ok = M.normPlayer({ playerId: 9, lineupSlotId: 1, injuryStatus: 'NORMAL', playerPoolEntry: { player: rawPlayer(9, 'Lee Doe', 8, [1, 5, 11, 12, 13]) } });
  assert.strictEqual(ok.injury, 'ACTIVE');
});
