/* Data for the Bets backtest and the stat-factor builder: ESPN scoreboards, game odds (totals and
   spreads), DraftKings player props, game logs and positions. Public ESPN data only, no cookies.
   Everything is cached in .cache/backtest/props/; finished games are kept for good. */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../web/bets.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'backtest', 'props');
const GAMELOGS = path.join(ROOT, '.cache', 'gamelogs'); // tools/build_factors.py keeps finished seasons here
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json',
};
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/';
const GAMELOG = (id, season) => 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/' + id + '/gamelog?season=' + season;
const PLAYERS = (season) => 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/' + season + '/segments/0/leaguedefaults/3?view=kona_player_info';

// Regular seasons by ESPN season id (2026 = 2025-26).
const SEASONS = {
  2025: { from: '2024-10-22', to: '2025-04-13' },
  2026: { from: '2025-10-21', to: '2026-04-12' },
  2027: { from: '2026-10-20', to: null }, // in progress: up to yesterday
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

function readCache(file, maxAgeH) {
  const f = path.join(CACHE, file);
  try {
    const st = fs.statSync(f);
    if (maxAgeH != null && Date.now() - st.mtimeMs > maxAgeH * 3600e3) return undefined;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return undefined;
  }
}
function writeCache(file, data) {
  const f = path.join(CACHE, file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data));
}

// GET JSON with retries; 404 gives null. file: cache path (relative), maxAgeH: null = forever.
async function getJSON(url, file, maxAgeH, extraHeaders) {
  if (file) {
    const hit = readCache(file, maxAgeH);
    if (hit !== undefined) return hit;
  }
  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      requests++;
      const r = await fetch(url, { headers: Object.assign({}, HEADERS, extraHeaders || {}) });
      if (r.status === 404) data = null;
      else if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.slice(0, 120));
      else data = await r.json();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  if (file) writeCache(file, data);
  return data;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

const ymd = (d) => d.replace(/-/g, '');
function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T12:00:00Z'); t <= Date.parse(to + 'T12:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const yesterday = () => new Date(Date.now() - 864e5 - 6 * 3600e3).toISOString().slice(0, 10);

/* Every game of a season: { id, date, start, home, away, total, spread } with the closing total and
   spread from ESPN's odds (DraftKings, or ESPN BET in 2024-25). */
async function seasonGames(season, log) {
  const S = SEASONS[season];
  const to = S.to || yesterday();
  const dates = datesBetween(S.from, to);
  const today = new Date().toISOString().slice(0, 10);
  const boards = await pool(dates, 8, (d) => getJSON(SITE + 'scoreboard?dates=' + ymd(d), 'sb/' + d + '.json', d >= today ? 1 : null));
  const games = [];
  boards.forEach((b) => B.parseScoreboard(b || {}).forEach((g) => { if (g.state === 'post') games.push(g); }));
  if (log) log('  ' + season + ': ' + games.length + ' games, reading closing totals...');
  await pool(games, 8, async (g) => {
    const o = await getJSON(CORE + g.id + '/competitions/' + g.id + '/odds', 'odds/' + g.id + '.json', null);
    const items = ((o && o.items) || []).filter((i) => i.provider && String(i.provider.id) !== '59'); // 59: live odds
    const it = items.find((i) => String(i.provider.id) === '100') || items[0];
    if (it) {
      if (isFinite(it.overUnder)) g.total = +it.overUnder;
      if (isFinite(it.spread)) g.spread = +it.spread;
    }
  });
  return games;
}

function indexGames(games) {
  const byId = {}, teamDates = {};
  games.forEach((g) => {
    byId[g.id] = g;
    [g.home.id, g.away.id].forEach((t) => { (teamDates[t] = teamDates[t] || new Set()).add(g.date); });
  });
  return { byId, teamDates };
}

const STD_LABELS = ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS'];
// tools/build_factors.py's cached game logs ({id, team, opp, home, stats}) in the shape normGamelog reads.
function rowsFromFactorsCache(games, byId) {
  const events = {};
  games.forEach((g, i) => {
    const e = byId && byId[g.id];
    events[g.id] = {
      gameDate: e ? new Date(e.start).toISOString() : new Date(Date.UTC(2000, 0, 1) + i * 864e5).toISOString(),
      atVs: g.home ? 'vs' : '@', opponent: { abbreviation: g.opp }, team: { id: String(g.team) },
    };
  });
  return B.normGamelog({ labels: STD_LABELS, events, seasonTypes: [{ displayName: 'Regular Season', categories: [{ events: games.map((g) => ({ eventId: g.id, stats: g.stats })) }] }] });
}

function cachedIds(season) {
  try {
    return fs.readdirSync(GAMELOGS).filter((f) => f.startsWith(season + '-')).map((f) => f.slice(5, -5));
  } catch (e) {
    return [];
  }
}

// One player's games in a season: build_factors' cache when it has him, else ESPN (kept for 12 hours
// for the season in progress).
async function playerRows(season, id, byId) {
  const f = path.join(GAMELOGS, season + '-' + id + '.json');
  if (fs.existsSync(f)) return rowsFromFactorsCache(JSON.parse(fs.readFileSync(f, 'utf8')), byId);
  const live = !SEASONS[season] || !SEASONS[season].to;
  const raw = await getJSON(GAMELOG(id, season), 'gl/' + season + '-' + id + '.json', live ? 12 : null);
  return B.normGamelog(raw);
}

// ESPN position (1 PG ... 5 C) and name for a list of player ids.
async function positions(season, ids) {
  const file = 'pos/' + season + '.json';
  const known = readCache(file) || {};
  const missing = ids.filter((id) => !(id in known));
  for (let i = 0; i < missing.length; i += 150) {
    const chunk = missing.slice(i, i + 150).map(Number);
    const flt = { players: { filterIds: { value: chunk }, limit: chunk.length, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterStatsForSourceIds: { value: [0] }, filterStatsForSplitTypeIds: { value: [0] } } };
    const data = await getJSON(PLAYERS(season), null, null, { 'x-fantasy-filter': JSON.stringify(flt) });
    ((data && data.players) || []).forEach((p) => { known[String(p.id)] = { pos: p.player.defaultPositionId, name: p.player.fullName }; });
    chunk.forEach((id) => { if (!(String(id) in known)) known[String(id)] = null; });
  }
  writeCache(file, known);
  return known;
}

// DraftKings player props for a finished game (closing lines).
async function gameProps(id) {
  return getJSON(CORE + id + '/competitions/' + id + '/odds/100/propBets?limit=1000&pageSize=1000', 'props/' + id + '.json', null);
}

module.exports = { SEASONS, CACHE, getJSON, pool, seasonGames, indexGames, playerRows, cachedIds, positions, gameProps, yesterday, requests: () => requests };

// The n most rostered players in ESPN fantasy for a season: [{ id, pos, name }].
async function topPlayers(season, n) {
  const flt = { players: { limit: n, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterSlotIds: { value: [0, 1, 2, 3, 4, 5, 6, 11] }, filterStatsForSourceIds: { value: [0] }, filterStatsForSplitTypeIds: { value: [0] } } };
  const data = await getJSON(PLAYERS(season), 'top/' + season + '-' + n + '.json', 24, { 'x-fantasy-filter': JSON.stringify(flt) });
  return ((data && data.players) || []).map((p) => ({ id: String(p.id), pos: p.player.defaultPositionId, name: p.player.fullName }));
}
module.exports.topPlayers = topPlayers;
