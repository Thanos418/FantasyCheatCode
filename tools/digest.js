#!/usr/bin/env node
/* Daily digest: prints the facts you want each morning (score, win chance, who plays today, injuries,
   role changes, best add) as plain text, one fact per line. Suitable for a scheduled task.

     node tools/digest.js                  the league in use, reads config.json (leagues, espn_s2, swid)
     node tools/digest.js --league <id|name>  another saved league
     node tools/digest.js --all            every saved league, one after the other
     node tools/digest.js --demo           fake league, no cookies and no network

   It runs the same code as the web app: web/factors.js, model.js, insights.js and espn.js are loaded into one
   vm context (plus demo-data.js with --demo). Exit code 0 on success, 1 with a message on stderr otherwise.
   The cookies are only sent to ESPN and never printed. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DEFAULT_LEAGUE_ID = 1257343892;
const GUID_RE = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const REQUEST_TIMEOUT_MS = 30000;
const USAGE = 'Usage: node tools/digest.js [--league <id or name> | --all | --demo]';

class Fail extends Error {}

/* ------------------------------------------------------------------ config */

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  return typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : null;
}

// Same clean-up as server.py's norm_swid / norm_s2, so a hand-edited config.json works too.
function normSwid(value) {
  let s = String(value).trim();
  try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
  s = s.trim().replace(/^["']+|["']+$/g, '').replace(/^swid\s*=\s*/i, '').replace(/;+$/, '').trim().replace(/^[{}]+|[{}]+$/g, '').trim();
  if (!GUID_RE.test(s)) throw new Fail('The swid in config.json should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}. Copy it exactly as shown in Chrome.');
  return '{' + s.toUpperCase() + '}';
}

function normS2(value) {
  const s = String(value).trim().replace(/^["']+|["']+$/g, '').replace(/^espn_s2\s*=\s*/i, '').replace(/;+$/, '').trim();
  if (s.length < 20 || /[\s;,]/.test(s) || /[^\x21-\x7e]/.test(s)) {
    throw new Fail('The espn_s2 in config.json looks wrong (it is a long value with no spaces). Copy it exactly as shown in Chrome.');
  }
  return s;
}

function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') { // do not echo e.message: a JSON error can quote part of the file
      throw new Fail('config.json could not be read as JSON. Fix it, or save your ESPN cookies again from the app setup screen.');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Fail('config.json must be a JSON object. See config.example.json.');
  const now = new Date();
  const s2 = String(raw.espn_s2 || '').trim(), swid = String(raw.swid || '').trim();
  if (!s2 || !swid) {
    throw new Fail('No ESPN cookies saved. Put espn_s2 and swid in config.json (README, "Getting espn_s2 and SWID") or save them in the app setup screen, then run this again.');
  }
  const cfg = {
    leagueId: toInt(raw.leagueId) || DEFAULT_LEAGUE_ID,
    season: toInt(raw.season) || (now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear()),
    teamId: toInt(raw.teamId),
    s2: normS2(s2),
    swid: normSwid(swid),
  };
  // Every saved league (the app's league picker); the top-level one is the league in use.
  cfg.leagues = (Array.isArray(raw.leagues) ? raw.leagues : []).filter((l) => l && toInt(l.leagueId)).map((l) => ({
    leagueId: toInt(l.leagueId), season: toInt(l.season) || cfg.season, teamId: toInt(l.teamId), name: String(l.name || ''),
  }));
  if (!cfg.leagues.some((l) => l.leagueId === cfg.leagueId)) cfg.leagues.unshift({ leagueId: cfg.leagueId, season: cfg.season, teamId: cfg.teamId, name: '' });
  return cfg;
}

function pickLeagues(cfg, which, all) {
  if (all) return cfg.leagues;
  if (which == null) return [cfg.leagues.find((l) => l.leagueId === cfg.leagueId)];
  const id = toInt(which), q = String(which).toLowerCase();
  const hit = cfg.leagues.find((l) => l.leagueId === id) || cfg.leagues.find((l) => l.name && l.name.toLowerCase().includes(q));
  if (!hit) throw new Fail('No saved league matches "' + which + '". Saved: ' + cfg.leagues.map((l) => (l.name || 'League') + ' (' + l.leagueId + ')').join(', ') + '.');
  return [hit];
}

/* ------------------------------------------------------------------ context */

// Persists the probe cache (matchup period of each calendar week) between runs, so a daily run does not repeat ~25 requests.
function fileStorage(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const save = () => {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* cache is optional */ }
  };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); save(); },
    removeItem: (k) => { delete data[k]; save(); },
  };
}

function loadContext(demo, storage) {
  const sandbox = { console, setTimeout, clearTimeout, fetch: typeof fetch === 'function' ? fetch : undefined, URLSearchParams, Intl, Date, Math, JSON, Promise };
  if (storage) sandbox.localStorage = storage;
  const ctx = vm.createContext(sandbox);
  ['factors.js', 'model.js', 'insights.js', 'espn.js'].concat(demo ? ['demo-data.js'] : []).forEach((f) => {
    const file = path.join(WEB, f);
    if (!fs.existsSync(file)) throw new Fail('web/' + f + ' is missing. Run this from a complete copy of the project.');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  });
  return ctx;
}

// Same choice as the web app: the week that contains today, else the next one, else the last.
function pickWeek(base) {
  const L = base.league, weeks = base.weeks || [];
  let i = weeks.findIndex((w) => (w.sps || []).indexOf(L.currentSp) >= 0);
  if (i < 0) i = weeks.findIndex((w) => w.id === L.currentMp);
  if (i < 0) i = weeks.findIndex((w) => w.last >= L.currentSp);
  if (i < 0) i = weeks.length - 1;
  if (i < 0) throw new Fail('ESPN returned no weeks for this league. Check leagueId and season in config.json.');
  return weeks[i];
}

/* --------------------------------------------------------------------- main */

async function main(argv) {
  let demo = false, all = false, which = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') demo = true;
    else if (a === '--all') all = true;
    else if (a === '--league') { which = argv[++i]; if (which == null) throw new Fail('--league needs a league id or name. ' + USAGE); }
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else throw new Fail('Unknown option ' + a + '. ' + USAGE);
  }
  if (!demo && typeof fetch !== 'function') throw new Fail('This needs Node 18 or newer (this is Node ' + process.versions.node + ').');

  const cfg = demo ? null : readConfig();
  const leagues = demo ? [null] : pickLeagues(cfg, which, all);
  for (let i = 0; i < leagues.length; i++) {
    if (leagues.length > 1) console.log((i ? '\n' : '') + '== ' + (leagues[i].name || 'League ' + leagues[i].leagueId) + ' ==');
    await digestOne(cfg, leagues[i], demo);
  }
}

async function digestOne(cfg, lg, demo) {
  const secrets = cfg ? [cfg.s2, cfg.swid, cfg.swid.replace(/[{}]/g, '')] : [];
  const scrub = (msg) => secrets.reduce((m, s) => m.split(s).join('***'), String(msg));

  try {
    const ctx = loadContext(demo, demo ? null : fileStorage(path.join(ROOT, '.cache', 'digest-storage.json')));
    const timeoutFetch = (url, init) => fetch(url, Object.assign({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, init));
    const client = demo
      ? ctx.WPData.create(Object.assign({ mode: 'demo' }, ctx.WPDemo.config))
      : ctx.WPData.create({
        mode: 'direct', leagueId: lg.leagueId, season: lg.season, teamId: lg.teamId, swid: cfg.swid,
        cookie: 'espn_s2=' + cfg.s2 + '; SWID=' + cfg.swid, fetch: timeoutFetch,
      });

    const base = await client.loadBase();
    const week = pickWeek(base);
    const wctx = await client.loadWeek(base, week);
    const weekVm = ctx.WPModel.computeWeek(wctx);
    const wp = ctx.WPInsights.winProbability(weekVm, { factors: weekVm.isPoints ? wctx.factors : null });
    const mine = (wctx.rosters[base.myTeamId] || {}).current || [];
    const trendRows = ctx.WPInsights.trends(mine, base.league.season);
    const text = ctx.WPInsights.digest({ vm: weekVm, wp, trendRows, today: base.league.currentSp });
    console.log(Array.isArray(text) ? text.join('\n') : String(text));
  } catch (e) {
    if (e instanceof Fail) throw e;
    if (e && (e.status === 401 || e.status === 403)) {
      throw new Fail('ESPN rejected the saved cookies (espn_s2 / SWID). Copy fresh ones from Chrome into config.json (README, "Getting espn_s2 and SWID"), then run this again.');
    }
    throw new Fail('The digest failed: ' + scrub(e && e.message ? e.message : e));
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Fail ? e.message : 'The digest failed: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
