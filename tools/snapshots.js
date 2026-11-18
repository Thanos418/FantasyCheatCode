#!/usr/bin/env node
/* Price history for the Bets view. Betano and Betclic keep none, so this keeps our own: every few minutes
   it reads tonight's board (DraftKings, Betano, Betclic) and appends every price that changed to
   data/snapshots/<ET date>.jsonl. Each run also logs the value picks into the track record, as the
   Bets view does when it is open. After a few weeks, `report` answers what the backtest could not: how
   often the Portuguese books are behind DraftKings, for how long, and whether those prices beat
   DraftKings' closing line and the results.

     node tools/snapshots.js                     one snapshot of tonight now
     node tools/snapshots.js --every 10          one every 10 minutes until tonight's last game starts
     node tools/snapshots.js report              the report, for every finished night on file
     --date 2026-11-18                           another night (ET date)
     --server http://127.0.0.1:8765              the local server (the default); Betano only answers
                                                 through it, so keep it running (start.bat)

   A line of the file is one price: { t, k: athlete|stat, g: game, b: book, s: over|under|atleast,
   l: line or rung, d: decimal odds, or null when it was taken down }, or a snapshot marker
   { t, snap: 1, starts: { game: tip-off }, errors }. Prices from a book that could not be read in a
   snapshot are left as they were, not taken down. */
'use strict';
const fs = require('fs');
const path = require('path');

globalThis.WPBets = require('../web/bets.js');
const B = globalThis.WPBets;
const O = require('../web/odds.js');
const K = require('../web/picklog.js');
const F = require('../web/statfactors.js');

const DIR = path.join(__dirname, '..', 'data', 'snapshots');
const PICKS = path.join(__dirname, '..', 'data', 'picks.json');
const argv = process.argv.slice(2);
const arg = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
const SERVER = arg('--server') || 'http://127.0.0.1:8765';
const etToday = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const seasonOf = (date) => (+date.slice(5, 7) >= 8 ? +date.slice(0, 4) + 1 : +date.slice(0, 4));
const out = (s) => process.stdout.write(s + '\n');
const pc = (x) => (x == null || !isFinite(x) ? '-' : (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (date) => path.join(DIR, date + '.jsonl');
const idOf = (e) => e.k + '|' + e.b + '|' + e.s + '|' + e.l;

function readEvents(date) {
  if (!fs.existsSync(fileOf(date))) return [];
  return fs.readFileSync(fileOf(date), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s));
}

async function serverUp() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(SERVER + '/picks', { headers: { Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------ snapshots */

async function snapshot(client, viaServer, date, state) {
  const night = await client.loadNight(date, { season: seasonOf(date) });
  const now = Date.now();
  const board = B.buildBoard(night, F);
  const starts = {};
  night.games.forEach((g) => { starts[g.id] = g.start; });
  const seen = new Set(), lines = [];
  board.lines.forEach((L) => L.pr.bets.forEach((b) => {
    const e = { t: now, k: L.key, g: L.game.id, b: b.book, s: b.side, l: b.line, d: Math.round(b.dec * 1000) / 1000 };
    const id = idOf(e);
    seen.add(id);
    if (!state[id] || state[id].d !== e.d) { state[id] = e; lines.push(e); }
  }));
  const errors = night.errors || {};
  Object.keys(state).forEach((id) => {
    const e = state[id];
    if (e.d == null || seen.has(id) || errors[e.b] || !(starts[e.g] > now)) return; // keep a book that failed, and games under way
    const gone = Object.assign({}, e, { t: now, d: null });
    state[id] = gone;
    lines.push(gone);
  });
  lines.push({ t: now, snap: 1, starts, errors });
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(fileOf(date), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // The track record, as the Bets view keeps it.
  const recs = K.fromBoard(board, night, now);
  let changed = 0;
  if (recs.length) {
    if (viaServer) {
      const log = await client.picks.load();
      const ch = K.merge(log, recs);
      if (ch.length) await client.picks.save(ch);
      changed = ch.length;
    } else {
      const data = fs.existsSync(PICKS) ? JSON.parse(fs.readFileSync(PICKS, 'utf8')) : { version: 1, picks: {} };
      const ch = K.merge(data.picks, recs);
      if (ch.length) { fs.mkdirSync(path.dirname(PICKS), { recursive: true }); fs.writeFileSync(PICKS, JSON.stringify(data)); }
      changed = ch.length;
    }
  }
  const soft = board.picks.filter((p) => K.BETTABLE.indexOf(p.book) >= 0 && p.ev > 0);
  out(new Date(now).toLocaleTimeString() + '  ' + night.games.length + ' games, ' + (lines.length - 1) + ' prices changed, ' + soft.length + ' value picks at Betano/Betclic (' +
    soft.filter((p) => p.withMove).length + ' DraftKings moved towards), ' + changed + ' saved to the track record' +
    (Object.keys(errors).length ? ' | could not read: ' + Object.keys(errors).join(', ') : ''));
  return night;
}

async function logNight() {
  const date = arg('--date') || etToday();
  const every = +arg('--every') || 0;
  const viaServer = await serverUp();
  const client = viaServer ? O.create({ fetch, base: SERVER }) : O.create({ direct: true, fetch });
  out(viaServer ? 'Through the local server at ' + SERVER : 'Local server not running: reading the sources directly (Betano will not answer)');
  const state = {};
  readEvents(date).forEach((e) => { if (!e.snap) state[idOf(e)] = e; });
  for (;;) {
    let night = null;
    try {
      night = await snapshot(client, viaServer, date, state);
    } catch (e) {
      out(new Date().toLocaleTimeString() + '  snapshot failed: ' + e.message);
    }
    if (!every) return;
    const last = night && night.games.length ? Math.max(...night.games.map((g) => g.start || 0)) : null;
    if (night && (!night.games.length || Date.now() >= last)) { out('Every game of ' + date + ' has started: done.'); return; }
    await sleep(every * 60 * 1000);
  }
}

/* --------------------------------------------------------------- report */

// Over/under lines and ladder of one book for one player and stat, from the prices on file.
function bookMk(prices, book) {
  const byLine = {}, ladder = [];
  prices.forEach((e) => {
    if (e.b !== book || e.d == null) return;
    if (e.s === 'atleast') ladder.push({ k: e.l, dec: e.d });
    else (byLine[e.l] = byLine[e.l] || { line: e.l })[e.s] = e.d;
  });
  const lines = Object.keys(byLine).map((k) => byLine[k]).filter((x) => x.over > 1 && x.under > 1);
  return lines.length || ladder.length ? { lines, ladder } : null;
}

async function report() {
  const D = require('./props_data.js');
  const P = B.params();
  const nights = (fs.existsSync(DIR) ? fs.readdirSync(DIR) : []).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).filter((d) => d < etToday()).sort();
  if (!nights.length) return out('No finished nights in data/snapshots yet. Run `node tools/snapshots.js --every 10` on game days first.');
  const opps = {}; // first sighting of every value price at Betano or Betclic
  let snaps = 0;
  for (const date of nights) {
    const state = {};
    let prevMu = {}, prevDec = {};
    readEvents(date).forEach((e) => {
      if (!e.snap) { state[idOf(e)] = e; return; }
      snaps++;
      const byKey = {};
      Object.keys(state).forEach((id) => { const x = state[id]; if (x.d != null && e.starts[x.g] > e.t) (byKey[x.k] = byKey[x.k] || []).push(x); });
      const mu = {}, dec = {};
      Object.keys(byKey).forEach((k) => {
        const prices = byKey[k], m = k.split('|')[1];
        const books = ['DraftKings', 'Betano', 'Betclic'].map((b) => ({ book: b, mk: bookMk(prices, b) })).filter((x) => x.mk);
        if (!books.length || books[0].book !== 'DraftKings') return;
        const pr = B.price({ m, books, muModel: null, P });
        if (!pr || !pr.anchor) return;
        mu[k] = pr.mu;
        pr.bets.forEach((b) => {
          const id = k + '|' + b.book + '|' + b.side + '|' + b.line;
          dec[id] = b.dec;
          if (K.BETTABLE.indexOf(b.book) < 0 || !(b.ev > 0) || b.suspect || b.far) return;
          const o = opps[date + '|' + id];
          if (o) { o.lastSeen = e.t; return; }
          opps[date + '|' + id] = {
            date, k, athlete: k.split('|')[0], m, g: prices[0].g, start: e.starts[prices[0].g], book: b.book, side: b.side, line: b.line, dec: b.dec, ev: b.ev, at: e.t, lastSeen: e.t,
            // DraftKings moved since the last snapshot while this book's price stayed put
            dkMoved: prevMu[k] != null && Math.abs(pr.mu - prevMu[k]) >= 0.25 && prevDec[id] === b.dec,
          };
        });
      });
      prevMu = mu; prevDec = dec;
    });
  }
  const list = Object.keys(opps).map((k) => opps[k]);
  out('Snapshots: ' + nights.length + ' nights (' + nights[0] + ' to ' + nights[nights.length - 1] + '), ' + snaps + ' snapshots, ' + list.length + ' value prices seen at Betano/Betclic');
  if (!list.length) return;

  // DraftKings' closing lines and the box scores, from ESPN.
  const games = [...new Set(list.map((o) => o.g))];
  const closes = {};
  await D.pool(games, 8, async (g) => { const raw = await D.gameProps(g); closes[g] = raw ? B.parseEspnProps(raw) : null; });
  const rows = {};
  await D.pool([...new Set(list.map((o) => o.athlete))], 8, async (id) => { rows[id] = await D.playerRows(seasonOf(nights[0]), id, null); });
  list.forEach((o) => {
    const mk = closes[o.g] && closes[o.g].players[o.athlete] && closes[o.g].players[o.athlete].markets[o.m];
    if (mk && mk.lines.length) {
      const pr = B.price({ m: o.m, books: [{ book: 'DraftKings', mk: { lines: mk.lines, ladder: [] } }], muModel: null, P });
      if (pr && pr.anchor) {
        let p;
        if (o.side === 'atleast') p = pr.dist.atLeast(o.line);
        else { const x = pr.dist.line(o.line); p = (o.side === 'over' ? x.over : x.under) + x.push / 2; }
        o.clv = p * o.dec - 1;
      }
    }
    const row = (rows[o.athlete] || []).find((r) => r.id === String(o.g));
    if (row) { const v = B.statOf(row, o.m); const res = K.outcome(o.side, o.line, v); o.pnl = res === 'win' ? o.dec - 1 : res === 'loss' ? -1 : 0; }
  });

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const ci = (a) => { if (a.length < 2) return null; const m = mean(a); return 1.96 * Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1) / a.length); };
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const line = (name, os) => {
    const cl = os.filter((o) => o.clv != null).map((o) => o.clv), pn = os.filter((o) => o.pnl != null).map((o) => o.pnl);
    out('  ' + (name + ' '.repeat(38)).slice(0, 38) + String(os.length).padStart(6) + ' | ' + (os.length / nights.length).toFixed(1).padStart(5) + '/night | edge ' + pc(mean(os.map((o) => o.ev))).padStart(6) +
      ' | lasted ' + String(Math.round(median(os.map((o) => (o.lastSeen - o.at) / 60000)) || 0)).padStart(3) + ' min | CLV ' + pc(mean(cl)).padStart(6) + (ci(cl) != null ? ' ± ' + (100 * ci(cl)).toFixed(1) + '%' : '') +
      ' | ROI ' + pc(mean(pn)).padStart(6) + (ci(pn) != null ? ' ± ' + (100 * ci(pn)).toFixed(1) + '%' : '') + ' (' + pn.length + ')');
  };
  out('\nValue prices at Betano and Betclic, first time seen | per night | edge then | how long it stayed | v DraftKings\' close | results');
  [0, 0.03, 0.05, 0.1].forEach((t) => line('edge ' + 100 * t + '%+', list.filter((o) => o.ev >= t)));
  const v3 = list.filter((o) => o.ev >= 0.03);
  out('\nEdge 3%+, by book / time before tip-off / kind:');
  ['Betano', 'Betclic'].forEach((b) => line(b, v3.filter((o) => o.book === b)));
  [['3h+', 3, 99], ['1-3h', 1, 3], ['under 1h', 0, 1]].forEach(([n, a, b]) => line(n + ' before tip-off', v3.filter((o) => { const h = (o.start - o.at) / 3600e3; return h >= a && h < b; })));
  line('DraftKings just moved, book did not', v3.filter((o) => o.dkMoved));
  line('ladders (X+)', v3.filter((o) => o.side === 'atleast'));
  out('\nThe method holds up if CLV stays above about +2% with its range above zero over a few hundred prices, with a few a night.');
}

(argv[0] === 'report' ? report() : logNight()).catch((e) => { process.stderr.write('FAILED ' + (e.stack || e.message) + '\n'); process.exitCode = 1; });
