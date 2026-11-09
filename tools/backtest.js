#!/usr/bin/env node
/* Backtest: replays finished NBA seasons through the app's own code (web/model.js, web/insights.js),
   using only what was known before each game. Public ESPN data, no cookies.

     node tools/backtest.js                     2025-26 and 2024-25, 10 and 16 teams, 3 simulated leagues each
     node tools/backtest.js --quick             one season, 10 teams, one league
     node tools/backtest.js --seasons 2026 --teams 12 --leagues 5 --players 400

   It answers four questions:
     1. Projections: how far off is the per-game number, and which recipe is closest?
     2. Next 3 weeks: do real games and opponents beat an average schedule?
     3. Win chance: when the app says 70%, do you win 70% of the time?
     4. Add suggestions: does following them score more than standing still?

   Your real leagues did not exist in those seasons and ESPN keeps no past free-agent pools or daily injury
   lists, so 3 and 4 run on simulated leagues: rosters drafted from ESPN's preseason projections, the other teams
   stand still, nobody competes for free agents, and a player counts as out after missing his team's last 2 games.
   Fantasy points use ESPN's default points scoring. Data is cached in .cache/. */
'use strict';

const fs = require('fs');
const path = require('path');
const M = require('../web/model.js');
const I = require('../web/insights.js');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, '.cache', 'gamelogs');
const DATA = path.join(ROOT, '.cache', 'backtest');
const FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/';
const GAMELOG = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Same values as tools/build_factors.py
const MIN_GP = 20, MIN_GP_CURRENT = 5, MIN_AVG = 15, OPP_SHRINK = 150, CURRENT_SHRINK = 75;
const FLAT_GAMES_PER_WEEK = 82 / 24;
const LINEUP = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 3 }; // NBA Ngola's starting slots
const BENCH = 3;
const POLICIES = ['this-week', 'spend', 'every-worth'];
const POLICY_LABEL = {
  none: 'Never add anyone',
  'this-week': 'Best add every night, this week only',
  spend: 'Only "Spend your add here" (the app)',
  'every-worth': 'Every night the top add is worth it',
};

/* ---------------------------------------------------------------- loading */

async function getJson(url, headers) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers), signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Object.assign(new Error('ESPN answered ' + r.status), { status: r.status });
      return await r.json();
    } catch (e) {
      if (e.status === 404 || attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
}

async function cached(file, make) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = await make();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Same file format as tools/build_factors.py, so both share the cache.
function loadGamelog(pid, season) {
  return cached(path.join(LOGS, season + '-' + pid + '.json'), async () => {
    const games = [];
    let raw;
    try {
      raw = await getJson(GAMELOG + pid + '/gamelog?season=' + season);
    } catch (e) {
      if (e.status === 404) return games; // no log for that season: he did not play
      throw e;
    }
    (raw.seasonTypes || []).filter((st) => /Regular Season/.test(st.displayName || '')).forEach((st) => {
      (st.categories || []).forEach((cat) => (cat.events || []).forEach((e) => {
        const ev = raw.events[e.eventId];
        if (ev) games.push({ id: e.eventId, team: +ev.team.id, opp: ev.opponent.abbreviation, home: ev.atVs !== '@', stats: e.stats });
      }));
    });
    return games;
  });
}

function fpFromAverages(a) {
  const g = (k) => +a[k] || 0;
  return g(0) + g(17) + g(6) + 2 * g(3) + 4 * g(2) + 4 * g(1) - 2 * g(11) + 2 * g(13) - g(14) + g(15) - g(16);
}

// Players by end-of-season ownership, each with ESPN's preseason projection.
function loadPool(season) {
  return cached(path.join(DATA, 'pool-' + season + '.json'), async () => {
    const filt = { players: { limit: 650, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterSlotIds: { value: [0, 1, 2, 3, 4, 5, 6, 11] },
      filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: ['00' + season, '10' + season] } } };
    const raw = await getJson(FANTASY + 'seasons/' + season + '/segments/0/leaguedefaults/3?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(filt) });
    return raw.players.map((e) => {
      const p = e.player;
      const st = (p.stats || []).find((x) => x.id === '10' + season && x.averageStats);
      return { id: p.id, name: p.fullName, first: p.firstName, last: p.lastName, team: p.proTeamId, posId: p.defaultPositionId, eligible: p.eligibleSlots || [],
        own: (p.ownership && p.ownership.percentOwned) || 0, proj: st ? fpFromAverages(st.averageStats) : null, projGp: st && st.stats ? st.stats[42] || null : null };
    });
  });
}

function loadSchedule(season) {
  return cached(path.join(DATA, 'schedule-' + season + '.json'), () => getJson(FANTASY + 'seasons/' + season + '?view=proTeamSchedules_wl'));
}

async function loadSeason(season, nPlayers) {
  const [schedRaw, pool, prevSched, prevPool] = await Promise.all([loadSchedule(season), loadPool(season), loadSchedule(season - 1), loadPool(season - 1)]);
  // Chosen by preseason projection, so the sample has no hindsight.
  const top = pool.filter((p) => p.proj != null).sort((a, b) => b.proj - a.proj).slice(0, nPlayers);
  const logs = await mapLimit(top, 8, (p) => loadGamelog(p.id, season));
  const prevLogs = await mapLimit(prevPool.slice(0, 300), 8, (p) => loadGamelog(p.id, season - 1));
  return makeData(season, schedRaw, top, logs, measureSeason(prevSched, prevLogs));
}

/* ----------------------------------------------------------------- season */

function fantasyPoints(s) {
  const [fgm, fga] = s[1].split('-').map(Number);
  const tpm = Number(s[3].split('-')[0]);
  const [ftm, fta] = s[5].split('-').map(Number);
  const n = (i) => Math.trunc(parseFloat(s[i])) || 0;
  return n(13) + tpm + n(7) + 2 * n(8) + 4 * n(10) + 4 * n(9) - 2 * n(12) + 2 * fgm - fga + ftm - fta;
}

// How many values in the sorted array are below x.
function below(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

function schedDays(schedRaw) {
  const gameSp = {}, teamSps = {};
  schedRaw.settings.proTeams.forEach((t) => {
    if (!t.id) return;
    Object.keys(t.proGamesByScoringPeriod || {}).forEach((k) => (t.proGamesByScoringPeriod[k] || []).forEach((g) => {
      gameSp[g.id] = +k;
      (teamSps[t.id] = teamSps[t.id] || new Set()).add(+k);
    }));
  });
  return { gameSp, teamSps };
}

// One finished season's factors, the same way tools/build_factors.py measures them.
function measureSeason(schedRaw, logs) {
  const { gameSp, teamSps } = schedDays(schedRaw);
  const sums = {}, played = { b2b: [0, 0], rest: [0, 0] };
  const add = (k, fp, avg) => { const s = (sums[k] = sums[k] || [0, 0, 0]); s[0] += fp; s[1] += avg; s[2]++; };
  logs.forEach((log) => {
    const games = log.filter((g) => gameSp[g.id] != null);
    if (games.length < MIN_GP) return;
    const fps = games.map((g) => fantasyPoints(g.stats));
    const avg = fps.reduce((a, b) => a + b, 0) / fps.length;
    if (avg < MIN_AVG) return;
    games.forEach((g, i) => {
      const sp = gameSp[g.id];
      add('all', fps[i], avg);
      add(g.home ? 'home' : 'away', fps[i], avg);
      add('opp:' + g.opp, fps[i], avg);
      if (teamSps[g.team] && teamSps[g.team].has(sp - 1)) add('b2b', fps[i], avg);
    });
    const byTeam = {};
    games.forEach((g) => (byTeam[g.team] = byTeam[g.team] || new Set()).add(gameSp[g.id]));
    Object.keys(byTeam).forEach((team) => {
      const sps = [...byTeam[team]], lo = Math.min(...sps), hi = Math.max(...sps);
      (teamSps[team] || new Set()).forEach((sp) => {
        if (sp < lo || sp > hi) return;
        const kind = teamSps[team].has(sp - 1) ? 'b2b' : 'rest';
        played[kind][1]++;
        if (byTeam[team].has(sp)) played[kind][0]++;
      });
    });
  });
  const ratio = (k) => sums[k][0] / sums[k][1];
  const base = ratio('all');
  const opp = {};
  Object.keys(sums).filter((k) => k.startsWith('opp:')).forEach((k) => {
    const n = sums[k][2];
    opp[k.slice(4)] = 1 + (ratio(k) / base - 1) * n / (n + OPP_SHRINK);
  });
  return { home: ratio('home') / base, away: ratio('away') / base, b2bOutput: ratio('b2b') / base,
    b2bPlay: (played.b2b[0] / played.b2b[1]) / (played.rest[0] / played.rest[1]), opp };
}

function seasonWeeks(sched, lastSp) {
  const weeks = [];
  const lastCal = M.calendarWeekOf(sched, lastSp);
  for (let k = 1; k <= lastCal; k++) {
    const sps = M.calendarWeekSps(sched, k, lastSp);
    if (!sps.some((sp) => (sched.gamesBySp[sp] || []).length)) continue;
    weeks.push({ id: weeks.length + 1, sps, first: sps[0], last: sps[sps.length - 1], calWeeks: [k], playoff: false, long: false, label: 'Week ' + (weeks.length + 1), range: '' });
  }
  return weeks;
}

function makeData(season, schedRaw, pool, logs, prev) {
  const sched = M.buildProSchedule(schedRaw);
  const players = new Map();
  pool.forEach((p, i) => {
    const games = (logs[i] || []).filter((g) => sched.games[g.id])
      .map((g) => ({ sp: sched.games[g.id].sp, gid: g.id, team: g.team, opp: g.opp, home: g.home, fp: fantasyPoints(g.stats) }))
      .sort((a, b) => a.sp - b.sp);
    const cum = [0];
    games.forEach((g) => cum.push(cum[cum.length - 1] + g.fp));
    players.set(p.id, Object.assign({}, p, { games, sps: games.map((g) => g.sp), cum, bySp: new Map(games.map((g) => [g.sp, g])) }));
  });
  const lastSp = Math.max(...Object.keys(sched.gamesBySp).map(Number));
  const teamDays = {};
  Object.keys(sched.byTeam).forEach((t) => { teamDays[t] = Object.keys(sched.byTeam[t]).map(Number).sort((a, b) => a - b); });
  return { season, sched, players, prev, lastSp, teamDays, weeks: seasonWeeks(sched, lastSp), factorCache: new Map(), playerCache: new Map() };
}

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

// The player as the app would have seen him on the morning of day sp: nothing from sp onwards.
function playerAt(data, pid, sp, opts) {
  opts = opts || {};
  const p = data.players.get(pid);
  const S = data.season;
  const n = below(p.sps, sp);
  const stats = [{ id: '10' + S, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedAverage: p.proj, appliedTotal: p.proj * (p.projGp || 1), stats: { 42: p.projGp || 1 } }];
  if (n) {
    stats.push({ id: '00' + S, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: p.cum[n], appliedAverage: p.cum[n] / n, stats: { 42: n } });
    const from = below(p.sps, sp - 15), m = n - from;
    if (m) stats.push({ id: '02' + S, statSourceId: 0, statSplitTypeId: 2, scoringPeriodId: 0, appliedTotal: p.cum[n] - p.cum[from], appliedAverage: (p.cum[n] - p.cum[from]) / m, stats: { 42: m } });
  }
  if (opts.gamesFrom != null) {
    for (let i = below(p.sps, opts.gamesFrom); i < n; i++) {
      const g = p.games[i];
      stats.push({ id: '05' + g.gid, statSourceId: 0, statSplitTypeId: 5, scoringPeriodId: g.sp, appliedTotal: g.fp, appliedAverage: g.fp, stats: { 42: 1 } });
    }
  }
  const team = n ? p.games[n - 1].team : p.games.length ? p.games[0].team : p.team;
  const days = data.teamDays[team] || [];
  const d = below(days, sp);
  const out = d >= 2 && !p.bySp.has(days[d - 1]) && !p.bySp.has(days[d - 2]);
  return { id: pid, name: p.name, first: p.first, last: p.last, proTeamId: team, posId: p.posId, pos: POSITIONS.filter((x, i) => p.eligible.indexOf(i) >= 0).join('/'),
    eligible: p.eligible, injury: out ? 'OUT' : 'ACTIVE', slot: opts.slot != null ? opts.slot : 12, status: 'ONTEAM', waiverDate: null, own: { pct: p.own, chg: 0 }, stats };
}

function cachedPlayer(data, pid, sp) {
  const key = pid + ':' + sp;
  let v = data.playerCache.get(key);
  if (!v) { v = playerAt(data, pid, sp); data.playerCache.set(key, v); }
  return v;
}

// Factors as a weekly rebuild would have produced them: last season, moved towards this season's games so far.
function factorsAt(data, sp) {
  const week = M.calendarWeekOf(data.sched, sp);
  let F = data.factorCache.get(week);
  if (F) return F;
  const before = M.calendarWeekSps(data.sched, week, data.lastSp)[0];
  const sums = {};
  data.players.forEach((p) => {
    const n = below(p.sps, before);
    if (n < MIN_GP_CURRENT) return;
    const avg = p.cum[n] / n;
    if (avg < MIN_AVG) return;
    for (let i = 0; i < n; i++) {
      const s = (sums[p.games[i].opp] = sums[p.games[i].opp] || [0, 0, 0]);
      s[0] += p.games[i].fp; s[1] += avg; s[2]++;
    }
  });
  const opp = Object.assign({}, data.prev.opp);
  Object.keys(sums).forEach((t) => {
    if (opp[t] == null) return;
    const [fp, exp, n] = sums[t];
    opp[t] += (fp / exp - opp[t]) * n / (n + CURRENT_SHRINK);
  });
  F = Object.assign({}, data.prev, { opp });
  data.factorCache.set(week, F);
  return F;
}

/* ------------------------------------------------------- 1. per-game test */

function newStat() { return { n: 0, ae: 0, se: 0, e: 0 }; }
function addStat(s, pred, actual) { const d = pred - actual; s.n++; s.ae += Math.abs(d); s.se += d * d; s.e += d; }
const mae = (s) => s.ae / s.n;
const rmse = (s) => Math.sqrt(s.se / s.n);
const bias = (s) => s.e / s.n;

function testProjections(data) {
  const S = data.season;
  const games = [];
  data.players.forEach((p) => p.games.forEach((g) => games.push({ pid: p.id, g })));
  games.sort((a, b) => a.g.sp - b.g.sp);
  const recipes = {}, adjust = {};
  const R = (k) => (recipes[k] = recipes[k] || newStat());
  const A = (k) => (adjust[k] = adjust[k] || newStat());
  games.forEach(({ pid, g }) => {
    const p = data.players.get(pid), sp = g.sp, n = below(p.sps, sp);
    const cur = n ? p.cum[n] / n : null;
    const blend = (k) => (n ? (n / (n + k)) * cur + (k / (n + k)) * p.proj : p.proj);
    const from = below(p.sps, sp - 15);
    const l15 = n - from >= 3 ? (p.cum[n] - p.cum[from]) / (n - from) : null;
    const app = M.projectPlayer(playerAt(data, pid, sp), S, true).fp;
    if (Math.abs(app - blend(10)) > 1e-6) throw new Error('Backtest recipe and web/model.js disagree for ' + p.name);
    addStat(R('ESPN preseason only'), p.proj, g.fp);
    addStat(R('Season average only'), n ? cur : p.proj, g.fp);
    addStat(R('ESPN worth 20 games'), blend(20), g.fp);
    addStat(R('ESPN worth 10 games (the app)'), app, g.fp);
    addStat(R('ESPN worth 5 games'), blend(5), g.fp);
    addStat(R('ESPN worth 3 games'), blend(3), g.fp);
    addStat(R('Last 15 days'), l15 != null ? l15 : app, g.fp);
    addStat(R('Half the app, half last 15 days'), l15 != null ? (app + l15) / 2 : app, g.fp);
    const mult = (F) => { const m = M.gameMult(data.sched, F, g.team, sp); return m.mult / m.play; }; // played games only: chance of playing is not part of this test
    addStat(A('No adjustment'), app, g.fp);
    addStat(A('Venue and back-to-backs'), app * mult(Object.assign({}, data.prev, { opp: {} })), g.fp);
    addStat(A('Plus last season\'s defenses'), app * mult(data.prev), g.fp);
    addStat(A('Plus this season\'s defenses (the app)'), app * mult(factorsAt(data, sp)), g.fp);
  });
  return { recipes, adjust, games: games.length };
}

/* ------------------------------------------------------ 2. next 3 weeks */

function testWindows(data, seed) {
  const S = data.season, rng = mulberry32(seed || 7);
  const flat = newStat(), real = newStat();
  const pairs = { flat: 0, real: 0, n: 0 };
  for (let cp = 21; cp < data.lastSp - 28; cp += 7) {
    const frm = cp + 7, to = cp + 27, F = factorsAt(data, cp);
    const rows = [];
    data.players.forEach((p) => {
      const n = below(p.sps, cp);
      if (n < 5) return;
      const P = playerAt(data, p.id, cp);
      const fp = M.projectPlayer(P, S, true).fp;
      let sched = 0;
      for (let sp = frm; sp <= to; sp++) if (M.teamGame(data.sched, P.proTeamId, sp)) sched += fp * M.gameMult(data.sched, F, P.proTeamId, sp).mult;
      const actual = p.cum[below(p.sps, to + 1)] - p.cum[below(p.sps, frm)];
      const fl = fp * FLAT_GAMES_PER_WEEK * 3;
      addStat(flat, fl, actual);
      addStat(real, sched, actual);
      rows.push([fl, sched, actual]);
    });
    shuffle(rows, rng);
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const [a, b] = [rows[i], rows[i + 1]];
      if (a[2] === b[2]) continue;
      pairs.n++;
      if ((a[0] - b[0]) * (a[2] - b[2]) > 0) pairs.flat++;
      if ((a[1] - b[1]) * (a[2] - b[2]) > 0) pairs.real++;
    }
  }
  return { flat, real, pairs };
}

/* ------------------------------------------------- 3 and 4. simulated leagues */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

// Snake draft on ESPN's preseason projection with some noise, at most 3 pure centers per team.
function draft(data, nTeams, rosterSize, rng) {
  const board = [...data.players.values()].map((p) => ({ id: p.id, v: p.proj * (0.93 + 0.14 * rng()), pureC: p.eligible.indexOf(4) >= 0 && ![0, 1, 2, 3].some((s) => p.eligible.indexOf(s) >= 0) }))
    .sort((a, b) => b.v - a.v);
  const rosters = Array.from({ length: nTeams }, () => []), centers = new Array(nTeams).fill(0), taken = new Set();
  for (let r = 0; r < rosterSize; r++) {
    const order = Array.from({ length: nTeams }, (_, i) => (r % 2 ? nTeams - 1 - i : i));
    order.forEach((t) => {
      const pick = board.find((x) => !taken.has(x.id) && !(x.pureC && centers[t] >= 3));
      if (!pick) throw new Error('Not enough players to draft ' + nTeams + ' teams.');
      taken.add(pick.id);
      rosters[t].push(pick.id);
      if (pick.pureC) centers[t]++;
    });
  }
  return rosters;
}

function roundRobin(n, weeks) {
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const r = w % (n - 1);
    const a = [1];
    for (let i = 0; i < n - 1; i++) a.push(2 + ((i + r) % (n - 1)));
    const pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push([a[i], a[n - 1 - i]]);
    out.push(pairs);
  }
  return out;
}

function makeLeague(data, nTeams, caps, bench) {
  const teams = {};
  for (let t = 1; t <= nTeams; t++) teams[t] = { id: t, name: 'Team ' + t, abbrev: 'T' + t, owners: [], logo: null, record: { wins: 0, losses: 0, ties: 0 }, addsByMp: {} };
  const starters = Object.values(caps).reduce((a, b) => a + b, 0);
  return { id: 0, season: data.season, name: 'Backtest', size: nTeams, scoringType: 'H2H_POINTS', isPoints: true, caps, starters, benchCount: bench, irCount: 0,
    acq: { limit: 1, perDay: true }, matchupPeriods: {}, regularCount: data.weeks.length, currentSp: 1, currentMp: 1, firstSp: 1, finalSp: data.lastSp, teams, matchups: [] };
}

function morningOf(data, sp) {
  const dates = (data.sched.gamesBySp[sp] || []).map((g) => g.date).filter((d) => typeof d === 'number');
  return dates.length ? Math.min(...dates) - 3600e3 : Date.parse(M.spDate(data.sched, sp) + 'T12:00:00Z');
}

function lineupFor(data, league, roster, sp, F) {
  const cands = [];
  roster.forEach((pid) => {
    const P = cachedPlayer(data, pid, sp);
    if (P.injury === 'OUT' || !M.teamGame(data.sched, P.proTeamId, sp)) return;
    cands.push({ key: String(pid), w: M.projectPlayer(P, data.season, true).fp * M.gameMult(data.sched, F, P.proTeamId, sp).mult, slots: P.eligible });
  });
  return M.bestLineup(cands, league.caps);
}

function scoreLineup(data, res, sp) {
  let t = 0;
  res.chosen.forEach((c) => { const g = data.players.get(+c.key).bySp.get(sp); if (g) t += g.fp; });
  return t;
}

// Win chance for one side on the morning of sp, with the week so far as it really went.
function winChance(data, league, week, a, b, drafted, slots, sp, F, opts) {
  const side = (t) => {
    const bySp = {};
    week.sps.filter((s) => s < sp).forEach((s) => {
      bySp[s] = drafted[t - 1].map((pid) => playerAt(data, pid, sp, { gamesFrom: week.first, slot: slots[t][s].has(String(pid)) ? slots[t][s].get(String(pid)) : 12 }));
    });
    return { current: drafted[t - 1].map((pid) => playerAt(data, pid, sp, { gamesFrom: week.first })), bySp };
  };
  const vm = M.computeWeek({
    league: Object.assign({}, league, { currentSp: sp, currentMp: week.id, matchups: [{ mp: week.id, home: { teamId: a, total: 0, bySp: {} }, away: { teamId: b, total: 0, bySp: {} } }] }),
    sched: data.sched, week, now: morningOf(data, sp), myTeamId: a, rosters: { [a]: side(a), [b]: side(b) }, freeAgents: [], transactions: [], factors: F,
  });
  return I.winProbability(vm, { factors: F, sims: opts.sims, seed: sp * 1000 + a }).pWin;
}

function pickMove(policy, vm, sp) {
  const top = vm.recs.byDay[sp] && vm.recs.byDay[sp][0];
  if (policy === 'this-week') return top || null;
  if (policy === 'every-worth') return top && top.worth ? top : null;
  return vm.recs.spend && vm.recs.spend.sp === sp ? vm.recs.spend : null;
}

function runPolicy(data, league, policy, teamId, drafted, schedule, control) {
  let roster = drafted[teamId - 1].slice();
  const others = new Set();
  drafted.forEach((r, i) => { if (i !== teamId - 1) r.forEach((pid) => others.add(pid)); });
  const out = { points: 0, weeks: 0, wins: 0, adds: 0 };
  data.weeks.forEach((week, wi) => {
    let total = 0;
    week.sps.forEach((sp) => {
      const F = factorsAt(data, sp);
      const freeAgents = [];
      data.players.forEach((p, pid) => { if (!others.has(pid) && roster.indexOf(pid) < 0) freeAgents.push(cachedPlayer(data, pid, sp)); });
      const ctx = { league: Object.assign({}, league, { currentSp: sp, currentMp: week.id }), sched: data.sched, week, now: morningOf(data, sp), myTeamId: teamId,
        rosters: { [teamId]: { current: roster.map((pid) => cachedPlayer(data, pid, sp)), bySp: {} } }, freeAgents, transactions: [], factors: F };
      if (policy === 'this-week') ctx.longTermWeeks = 0;
      const rec = pickMove(policy, M.computeWeek(ctx), sp);
      if (rec) {
        roster = roster.filter((pid) => !rec.drop || pid !== rec.drop.id).concat([rec.fa.id]);
        out.adds++;
      }
      total += scoreLineup(data, lineupFor(data, league, roster, sp, F), sp);
    });
    const pair = schedule[wi].find((x) => x.indexOf(teamId) >= 0);
    const opp = control[wi][pair[0] === teamId ? pair[1] : pair[0]];
    out.points += total; out.weeks++;
    out.wins += total > opp ? 1 : total === opp ? 0.5 : 0;
  });
  return out;
}

const CHECKPOINTS = [[0, 'Start of the week'], [3, 'Thursday morning'], [5, 'Saturday morning']];

function runLeague(data, opts) {
  const o = Object.assign({ teams: 10, seed: 1, caps: LINEUP, bench: BENCH, sims: 1500, policies: POLICIES }, opts);
  const size = Object.values(o.caps).reduce((a, b) => a + b, 0) + o.bench;
  const league = makeLeague(data, o.teams, o.caps, o.bench);
  const drafted = draft(data, o.teams, size, mulberry32(o.seed * 7919));
  const schedule = roundRobin(o.teams, data.weeks.length);

  // Everyone stands still: the baseline, and the win-chance test.
  const control = [], calibration = [];
  data.weeks.forEach((week, wi) => {
    const totals = {}, slots = {}, preds = [];
    for (let t = 1; t <= o.teams; t++) { totals[t] = 0; slots[t] = {}; }
    week.sps.forEach((sp, di) => {
      const F = factorsAt(data, sp);
      const cp = CHECKPOINTS.find((c) => c[0] === di);
      if (cp) schedule[wi].forEach(([a, b]) => preds.push({ a, b, label: cp[1], p: winChance(data, league, week, a, b, drafted, slots, sp, F, o) }));
      for (let t = 1; t <= o.teams; t++) {
        const res = lineupFor(data, league, drafted[t - 1], sp, F);
        slots[t][sp] = res.slotOf;
        totals[t] += scoreLineup(data, res, sp);
      }
    });
    control.push(totals);
    preds.forEach((x) => calibration.push({ label: x.label, p: x.p, won: totals[x.a] > totals[x.b] ? 1 : totals[x.a] === totals[x.b] ? 0.5 : 0 }));
  });

  const results = [];
  for (let t = 1; t <= o.teams; t++) {
    let base = { points: 0, weeks: 0, wins: 0, adds: 0 };
    data.weeks.forEach((w, wi) => {
      const pair = schedule[wi].find((x) => x.indexOf(t) >= 0);
      const mine = control[wi][t], opp = control[wi][pair[0] === t ? pair[1] : pair[0]];
      base.points += mine; base.weeks++; base.wins += mine > opp ? 1 : mine === opp ? 0.5 : 0;
    });
    const row = { none: base };
    o.policies.forEach((p) => { row[p] = runPolicy(data, league, p, t, drafted, schedule, control); });
    results.push(row);
  }
  return { calibration, results };
}

function calibrate(rows) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, p: 0, won: 0 }));
  let brier = 0;
  rows.forEach((r) => {
    const b = bins[Math.min(9, Math.floor(r.p * 10))];
    b.n++; b.p += r.p; b.won += r.won;
    brier += (r.p - r.won) * (r.p - r.won);
  });
  let gap = 0;
  bins.forEach((b) => { if (b.n) gap += Math.abs(b.p / b.n - b.won / b.n) * b.n; });
  return { n: rows.length, brier: rows.length ? brier / rows.length : null, gap: rows.length ? gap / rows.length : null, bins };
}

function summarizePolicies(rows, policies) {
  const out = {};
  ['none'].concat(policies).forEach((p) => {
    let pts = 0, weeks = 0, wins = 0, adds = 0;
    const dPts = [], dWin = [];
    rows.forEach((r) => {
      const x = r[p], b = r.none;
      pts += x.points; weeks += x.weeks; wins += x.wins; adds += x.adds;
      dPts.push(x.points / x.weeks - b.points / b.weeks);
      dWin.push(x.wins / x.weeks - b.wins / b.weeks);
    });
    const ci = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; const s = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1)) : 0; return { m, half: 1.96 * s / Math.sqrt(v.length) }; };
    out[p] = { pts: pts / weeks, win: wins / weeks, adds: adds / weeks, dPts: ci(dPts), dWin: ci(dWin) };
  });
  return out;
}

/* ----------------------------------------------------------------- report */

const pct = (x, d) => (100 * x).toFixed(d == null ? 1 : d) + '%';
const sgn = (x, d) => (x >= 0 ? '+' : '') + x.toFixed(d == null ? 1 : d);

function printStats(title, stats) {
  console.log('\n' + title);
  Object.keys(stats).forEach((k) => console.log('  ' + k.padEnd(40) + 'off by ' + mae(stats[k]).toFixed(3) + '   RMSE ' + rmse(stats[k]).toFixed(3) + '   bias ' + sgn(bias(stats[k]), 2)));
}

function printCalibration(rows) {
  const c = calibrate(rows);
  console.log('  All checkpoints: ' + c.n + ' predictions, Brier ' + c.brier.toFixed(4) + ' (always saying 50% scores 0.2500), average gap ' + pct(c.gap));
  c.bins.filter((b) => b.n).forEach((b) => console.log('    says ' + (Math.round(b.lo * 100) + '-' + Math.round(b.hi * 100) + '%').padEnd(8) + ' avg ' + pct(b.p / b.n).padStart(6) + '   really won ' + pct(b.won / b.n).padStart(6) + '   (' + b.n + ')'));
  CHECKPOINTS.forEach(([, label]) => {
    const sub = calibrate(rows.filter((r) => r.label === label));
    if (sub.n) console.log('  ' + label.padEnd(20) + 'Brier ' + sub.brier.toFixed(4) + ', average gap ' + pct(sub.gap));
  });
}

function parseArgs(argv) {
  const o = { seasons: [2026, 2025], teams: [10, 16], leagues: 3, players: 400, sims: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const list = () => String(argv[++i] || '').split(',').map(Number).filter(Boolean);
    if (a === '--seasons') o.seasons = list();
    else if (a === '--teams') o.teams = list();
    else if (a === '--leagues') o.leagues = list()[0] || o.leagues;
    else if (a === '--players') o.players = list()[0] || o.players;
    else if (a === '--quick') { o.seasons = [o.seasons[0]]; o.teams = [10]; o.leagues = 1; o.sims = 800; }
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error('Unknown option ' + a + '. Usage: node tools/backtest.js [--seasons 2026,2025] [--teams 10,16] [--leagues 3] [--players 400] [--quick]');
  }
  if (o.teams.some((t) => t % 2)) throw new Error('--teams needs even numbers.');
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log('Usage: node tools/backtest.js [--seasons 2026,2025] [--teams 10,16] [--leagues 3] [--players 400] [--quick]'); return; }
  for (const season of o.seasons) {
    const data = await loadSeason(season, o.players);
    console.log('\n==================== ' + (season - 1) + '-' + String(season).slice(2) + ' ====================');
    const a = testProjections(data);
    console.log(data.players.size + ' players, ' + a.games + ' games, ' + data.weeks.length + ' weeks. Points off per game (lower is better).');
    printStats('Per-game recipe', a.recipes);
    printStats('Adjustments for each game, on the app\'s recipe', a.adjust);
    const w = testWindows(data);
    console.log('\nNext 3 weeks, predicted from a week before they start (' + w.flat.n + ' player windows)');
    console.log('  Average schedule   off by ' + mae(w.flat).toFixed(1) + ' points   bias ' + sgn(bias(w.flat)));
    console.log('  Real games (app)   off by ' + mae(w.real).toFixed(1) + ' points   bias ' + sgn(bias(w.real)));
    console.log('  Picks the better of two players: average schedule ' + pct(w.pairs.flat / w.pairs.n) + ', real games ' + pct(w.pairs.real / w.pairs.n) + ' (' + w.pairs.n + ' pairs)');
    for (const teams of o.teams) {
      const calibration = [], results = [];
      for (let seed = 1; seed <= o.leagues; seed++) {
        const r = runLeague(data, { teams, seed, sims: o.sims });
        calibration.push(...r.calibration);
        results.push(...r.results);
        data.playerCache.clear();
      }
      console.log('\n--- ' + teams + ' teams, ' + o.leagues + ' simulated league(s) ---');
      console.log('Win chance');
      printCalibration(calibration);
      console.log('Add suggestions, per team and week against never adding (95% range)');
      const s = summarizePolicies(results, POLICIES);
      ['none'].concat(POLICIES).forEach((p) => {
        const x = s[p];
        console.log('  ' + POLICY_LABEL[p].padEnd(40) + x.pts.toFixed(1).padStart(8) + ' pts  ' + pct(x.win).padStart(6) + ' wins  ' + x.adds.toFixed(2).padStart(5) + ' adds/wk' +
          (p === 'none' ? '' : '   ' + sgn(x.dPts.m) + ' pts (±' + x.dPts.half.toFixed(1) + ')  ' + sgn(100 * x.dWin.m) + ' win pts (±' + (100 * x.dWin.half).toFixed(1) + ')'));
      });
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('The backtest failed: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
}

module.exports = { fantasyPoints, below, measureSeason, seasonWeeks, makeData, playerAt, factorsAt, testProjections, testWindows, mulberry32, draft, roundRobin, makeLeague, lineupFor, scoreLineup, runLeague, calibrate, summarizePolicies, parseArgs };
