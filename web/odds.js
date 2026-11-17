/* Data for the Bets view: one night's NBA games, DraftKings lines (through ESPN), Betano and Betclic
   prices, ESPN game logs, positions and the injury report. Everything goes through server.py's
   /odds/* and /injuries routes; nothing here sends cookies anywhere. A book that cannot be read is
   reported in `errors` and the rest of the night still loads. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WPOdds = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const bets = () => root.WPBets || (typeof require === 'function' ? require('./bets.js') : null);

  function create(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || ((u, o) => root.fetch(u, o));
    const base = opts.base || '';

    async function getJSON(url) {
      let r;
      try {
        r = await doFetch(base + url, { headers: { Accept: 'application/json' } });
      } catch (e) {
        // a reused connection the server had just closed: one more try on a fresh one
        r = await doFetch(base + url, { headers: { Accept: 'application/json' } });
      }
      if (!r.ok) {
        let msg = '';
        try { msg = (await r.json()).message; } catch (e) { /* not JSON */ }
        const err = new Error(msg || 'The local server answered HTTP ' + r.status + '.');
        err.status = r.status;
        throw err;
      }
      return r.json();
    }
    const soft = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));

    async function chunked(route, season, ids) {
      const out = {};
      for (let i = 0; i < ids.length; i += 150) {
        const part = await getJSON('/odds/' + route + '?season=' + season + '&ids=' + ids.slice(i, i + 150).join(','));
        if (route === 'players') ((part && part.players) || []).forEach((p) => { out[String(p.id)] = p.player; });
        else Object.assign(out, part);
      }
      return out;
    }

    const ymd = (d) => d.replace(/-/g, '');

    /* The night of `date` (YYYY-MM-DD, ET). progress(text) reports each step. */
    async function loadNight(date, o) {
      o = o || {};
      const B = bets();
      const say = o.progress || (() => {});
      const season = o.season;
      const errors = {};

      say('Reading the schedule and game lines…');
      const [sb, sbPrev] = await Promise.all([getJSON('/odds/scoreboard?date=' + ymd(date)), soft(getJSON('/odds/scoreboard?date=' + ymd(B.prevDay(date))))]);
      const games = B.parseScoreboard(sb).filter((g) => g.date === date);
      const playedYesterday = new Set();
      if (sbPrev.ok) B.parseScoreboard(sbPrev.ok).forEach((g) => { playedYesterday.add(g.home.id); playedYesterday.add(g.away.id); });
      if (!games.length) return { date, season, games: [], players: {}, errors, loadedAt: Date.now() };

      say('Reading DraftKings, Betano and Betclic…');
      const [dkRaw, bnLeague, bcLeague, inj] = await Promise.all([
        Promise.all(games.map((g) => soft(getJSON('/odds/props?event=' + g.id)))),
        soft(getJSON('/odds/betano')),
        soft(getJSON('/odds/betclic')),
        soft(getJSON('/injuries')),
      ]);
      const bnList = bnLeague.ok ? B.parseBetanoLeague(bnLeague.ok) : [];
      const bcList = bcLeague.ok ? B.parseBetclicLeague(bcLeague.ok) : [];
      if (bnLeague.err) errors.Betano = bnLeague.err.message;
      if (bcLeague.err) errors.Betclic = bcLeague.err.message;
      const [bnEvents, bcEvents] = await Promise.all([
        Promise.all(games.map((g) => { const m = B.matchGame(g, bnList); return m ? soft(getJSON('/odds/betano/event?path=' + encodeURIComponent(m.url))) : Promise.resolve({}); })),
        Promise.all(games.map((g) => { const m = B.matchGame(g, bcList); return m ? soft(getJSON('/odds/betclic/event?path=' + encodeURIComponent(m.path))) : Promise.resolve({}); })),
      ]);

      games.forEach((g, i) => {
        g.b2b = { home: playedYesterday.has(g.home.id), away: playedYesterday.has(g.away.id) };
        g.books = {};
        if (dkRaw[i].ok) g.books.DraftKings = B.parseEspnProps(dkRaw[i].ok);
        else if (dkRaw[i].err && !errors.DraftKings) errors.DraftKings = dkRaw[i].err.message;
        if (bnEvents[i].ok) g.books.Betano = B.parseBetanoEvent(bnEvents[i].ok);
        if (bcEvents[i].ok) g.books.Betclic = B.parseBetclicEvent(bcEvents[i].ok);
      });

      // Players: everyone DraftKings prices, plus injured teammates (for with/without splits).
      const ids = new Set();
      games.forEach((g) => { if (g.books.DraftKings) Object.keys(g.books.DraftKings.players).forEach((id) => ids.add(id)); });
      const teams = new Set();
      games.forEach((g) => { teams.add(g.home.id); teams.add(g.away.id); });
      const outList = inj.ok ? B.parseInjuryList(inj.ok).filter((x) => teams.has(x.teamId) && /^out$/i.test(x.status)) : [];
      const outIds = outList.map((x) => String(x.id)).filter((id) => !ids.has(id));
      const propIds = Array.from(ids);
      if (!propIds.length) return { date, season, games, players: {}, out: outList, errors, loadedAt: Date.now() };

      say('Reading ' + propIds.length + ' players’ game logs…');
      const [info, logs, prevLogs] = await Promise.all([
        chunked('players', season, propIds),
        chunked('gamelogs', season, propIds.concat(outIds)),
        chunked('gamelogs', season - 1, propIds),
      ]);
      const players = {};
      propIds.concat(outIds).forEach((id) => {
        const p = info[id] || {};
        const out = outList.find((x) => String(x.id) === id);
        players[id] = {
          id, name: p.fullName || (out && out.name) || 'Player ' + id, posId: p.defaultPositionId, grp: B.posGroup(p.defaultPositionId),
          proTeamId: p.proTeamId, injury: p.injuryStatus || null,
          rows: B.normGamelog(logs[id]), prev: B.normGamelog(prevLogs[id]), propped: ids.has(id),
        };
      });
      return { date, season, games, players, out: outList, errors, loadedAt: Date.now() };
    }

    return { loadNight, getJSON };
  }

  return { create };
});
