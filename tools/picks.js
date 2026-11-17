#!/usr/bin/env node
/* The Bets track record from the command line: grade finished picks, log tonight's value picks, print
   the record. It keeps the same file the Bets view uses, data/picks.json.

   When the local server is running (python server.py) everything goes through it, as in the browser.
   Without it the script asks ESPN, Betano and Betclic itself (no cookies); Betano refuses requests that
   do not come from a browser or the server, so a night logged that way has Betclic's prices only.

     node tools/picks.js                    grade what finished, print the track record
     node tools/picks.js log                also log tonight's value picks first (for a scheduled task)
     node tools/picks.js log --date 2026-11-18   a given night (ET date)
     --server http://127.0.0.1:8765         where to look for the local server (that is the default)
*/
'use strict';
const fs = require('fs');
const path = require('path');

globalThis.WPBets = require('../web/bets.js');
const B = globalThis.WPBets;
const O = require('../web/odds.js');
const K = require('../web/picklog.js');
const F = require('../web/statfactors.js');

const FILE = path.join(__dirname, '..', 'data', 'picks.json');
const argv = process.argv.slice(2);
const LOG = argv.includes('log');
const dateArg = argv.indexOf('--date') >= 0 ? argv[argv.indexOf('--date') + 1] : null;
const SERVER = argv.indexOf('--server') >= 0 ? argv[argv.indexOf('--server') + 1] : 'http://127.0.0.1:8765';
const etToday = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const seasonOf = (date) => (+date.slice(5, 7) >= 8 ? +date.slice(0, 4) + 1 : +date.slice(0, 4));
const out = (s) => process.stdout.write(s + '\n');
const pc = (x) => (x == null ? '-' : (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%');
const un = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + ' u';

function load() {
  if (!fs.existsSync(FILE)) return { version: 1, picks: {} };
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); // a broken file stops here, untouched
  if (!data || typeof data.picks !== 'object') throw new Error('data/picks.json is not a track record; nothing was changed.');
  return data;
}
function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

// The local server, if it is up and has the /picks route.
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

(async () => {
  if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) throw new Error('--date takes YYYY-MM-DD');
  const viaServer = await serverUp();
  const client = viaServer ? O.create({ fetch, base: SERVER }) : O.create({ direct: true, fetch });
  out(viaServer ? 'Through the local server at ' + SERVER : 'Local server not running: reading the sources directly (Betano will not answer)');
  const data = viaServer ? { version: 1, picks: await client.picks.load() } : load();
  const log = data.picks;
  const dirty = {};
  let changed = 0;

  if (LOG) {
    const date = dateArg || etToday();
    const night = await client.loadNight(date, { season: seasonOf(date) });
    Object.keys(night.errors).forEach((b) => out(b + ' could not be read: ' + night.errors[b]));
    const board = B.buildBoard(night, F);
    const recs = K.fromBoard(board, night, Date.now());
    const ch = K.merge(log, recs);
    ch.forEach((r) => { dirty[r.id] = r; });
    changed += ch.length;
    out(date + ': ' + night.games.length + ' games, ' + recs.length + ' value picks at Betano and Betclic (' + ch.length + ' new or updated)');
  }

  const todo = K.ungraded(log, etToday());
  const seasons = {};
  todo.forEach((r) => { (seasons[seasonOf(r.date)] = seasons[seasonOf(r.date)] || []).push(r); });
  let graded = 0;
  for (const season of Object.keys(seasons)) {
    const { rows, closes } = await client.loadResults(seasons[season], +season);
    seasons[season].forEach((r) => {
      const g = K.grade(r, rows[r.athlete], closes[r.event], B.DEFAULTS, Date.now());
      if (g) { log[g.id] = g; dirty[g.id] = g; graded++; }
    });
  }
  changed += graded;
  if (todo.length) out('Graded ' + graded + ' of ' + todo.length + ' finished picks' + (graded < todo.length ? ' (the rest have no box score yet)' : ''));
  if (changed) {
    if (viaServer) await client.picks.save(Object.keys(dirty).map((k) => dirty[k]));
    else save(data);
  }

  const s = K.summary(log);
  const a = s.all;
  out('\nTrack record: ' + a.n + ' value picks, ' + a.settled + ' settled, ' + a.pending + ' to come' + (a.void ? ', ' + a.void + ' void' : ''));
  if (a.settled) {
    out('  Record ' + a.win + '-' + a.loss + (a.push ? '-' + a.push : '') + ' · profit ' + un(a.units) + ' at 1 unit a pick · return ' + pc(a.roi) + (a.roiSe != null ? ' ± ' + (196 * a.roiSe).toFixed(1) + '%' : ''));
    out('  Expected when logged ' + un(a.expected) + ' (average edge ' + pc(a.evAvg) + ')');
    if (a.clvN) out('  Against the closing line ' + pc(a.clvAvg) + ' over ' + a.clvN + ' picks' + (a.clvSe != null ? ' ± ' + (196 * a.clvSe).toFixed(1) + '%' : ''));
    const line = (name, g) => Object.keys(g).forEach((k) => { const x = g[k]; if (x.settled) out('    ' + (name(k) + '                  ').slice(0, 20) + x.win + '-' + x.loss + '  ' + un(x.units).padStart(9) + '  closing ' + pc(x.clvAvg)); });
    out('  By book:'); line((k) => k, s.byBook);
    out('  By stat:'); line((k) => (B.MARKETS[k] ? B.MARKETS[k].label : k), s.byStat);
  }
  const p = s.placed;
  if (p.n) out('\nYour bets: ' + p.n + ' placed, ' + p.settled + ' settled' + (p.settled ? ': €' + p.staked.toFixed(2) + ' staked, ' + (p.profit >= 0 ? '+' : '-') + '€' + Math.abs(p.profit).toFixed(2) + ' (' + pc(p.roi) + ')' : '') + (p.pending ? ', €' + p.open.toFixed(2) + ' still open' : ''));
})().catch((e) => { process.stderr.write('FAILED ' + (e.stack || e.message) + '\n'); process.exitCode = 1; });
