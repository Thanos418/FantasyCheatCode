/* Data for the Bets view: one night's NBA games, DraftKings lines (through ESPN), Betano and Betclic
   prices, ESPN game logs, positions and the injury report, plus the inputs for grading the track
   record (box scores and DraftKings' closing lines).

   In the browser everything goes through server.py's /odds/*, /injuries and /picks routes. With
   { direct: true } (Node, tools/picks.js) it asks the same public addresses itself, so no server is
   needed. Nothing here sends cookies anywhere. A book that cannot be read is reported in `errors` and
   the rest of the night still loads. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WPOdds = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const bets = () => root.WPBets || (typeof require === 'function' ? require('./bets.js') : null);

  const UP = {
    scoreboard: (d) => 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + d + '&limit=200',
    props: (ev, page) => 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/' + ev + '/competitions/' + ev + '/odds/100/propBets?limit=1000&pageSize=1000&page=' + page,
    gamelog: (id, season) => 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/' + id + '/gamelog?season=' + season,
    players: (season) => 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/' + season + '/segments/0/leaguedefaults/3?view=kona_player_info',
    injuries: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
    betano: 'https://www.betano.pt/api/sport/basquetebol/eua/nba/441g/?req=la,s,stnf,c,mb',
    betanoEvent: (path) => 'https://www.betano.pt/api' + path + '?bt=1&req=la,s,stnf,c,mb',
    betclic: 'https://www.betclic.pt/basquetebol-sbasketball/nba-c13',
    betclicBase: 'https://www.betclic.pt',
  };
  const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  // Betclic has no API: its pages carry their odds as Angular state. Same as server.py's _betclic_state.
  function betclicState(html) {
    const m = /<script id="ng-state" type="application\/json">([\s\S]*?)<\/script>/.exec(html || '');
    if (!m) throw new Error('Betclic changed its page: no odds found.');
    const st = JSON.parse(m[1]);
    const out = {};
    Object.keys(st).forEach((k) => { if (k.indexOf('grpc:') === 0) out[k] = st[k]; });
    return out;
  }

  function create(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || ((u, o) => root.fetch(u, o));
    const base = opts.base || '';
    const direct = !!opts.direct;

    async function get(url, as, headers) {
      const init = { headers: Object.assign({ Accept: as === 'text' ? 'text/html,application/xhtml+xml' : 'application/json' }, direct ? { 'User-Agent': BROWSER_UA } : {}, headers || {}) };
      let r;
      try {
        r = await doFetch(direct ? url : base + url, init);
      } catch (e) {
        r = await doFetch(direct ? url : base + url, init); // a reused connection just closed: one more try
      }
      if (!r.ok) {
        let msg = '';
        try { msg = (await r.json()).message; } catch (e) { /* not JSON */ }
        const err = new Error(msg || (direct ? 'HTTP ' + r.status + ' from ' + url.split('/')[2] : 'The local server answered HTTP ' + r.status + '.'));
        err.status = r.status;
        throw err;
      }
      return as === 'text' ? r.text() : r.json();
    }
    const soft = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));
    const ymd = (d) => d.replace(/-/g, '');

    async function pool(items, n, fn) {
      const out = new Array(items.length);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
      }));
      return out;
    }

    // One source each; the same answers in both modes.
    const src = {
      scoreboard: (date) => (direct ? get(UP.scoreboard(ymd(date))) : get('/odds/scoreboard?date=' + ymd(date))),
      async props(ev) {
        if (!direct) return get('/odds/props?event=' + ev);
        const first = await get(UP.props(ev, 1));
        for (let p = 2; p <= Math.min(first.pageCount || 1, 6); p++) first.items = first.items.concat((await get(UP.props(ev, p))).items || []);
        return first;
      },
      async gamelogs(season, ids) {
        const out = {};
        if (!direct) {
          for (let i = 0; i < ids.length; i += 150) Object.assign(out, await get('/odds/gamelogs?season=' + season + '&ids=' + ids.slice(i, i + 150).join(',')));
          return out;
        }
        await pool(ids, 8, async (id) => { try { out[id] = await get(UP.gamelog(id, season)); } catch (e) { out[id] = null; } });
        return out;
      },
      async players(season, ids) {
        const out = {};
        for (let i = 0; i < ids.length; i += 150) {
          const chunk = ids.slice(i, i + 150);
          const part = direct
            ? await get(UP.players(season), 'json', { 'x-fantasy-filter': JSON.stringify({ players: { filterIds: { value: chunk.map(Number) }, limit: chunk.length, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterStatsForSourceIds: { value: [0, 1] }, filterStatsForSplitTypeIds: { value: [0] } } }) })
            : await get('/odds/players?season=' + season + '&ids=' + chunk.join(','));
          ((part && part.players) || []).forEach((p) => { out[String(p.id)] = p.player; });
        }
        return out;
      },
      injuries: () => get(direct ? UP.injuries : '/injuries'),
      betano: () => get(direct ? UP.betano : '/odds/betano'),
      betanoEvent: (path) => get(direct ? UP.betanoEvent(path) : '/odds/betano/event?path=' + encodeURIComponent(path)),
      betclic: async () => (direct ? betclicState(await get(UP.betclic, 'text')) : get('/odds/betclic')),
      betclicEvent: async (path) => (direct ? betclicState(await get(UP.betclicBase + path, 'text')) : get('/odds/betclic/event?path=' + encodeURIComponent(path))),
    };

    /* The night of `date` (YYYY-MM-DD, ET). progress(text) reports each step. */
    async function loadNight(date, o) {
      o = o || {};
      const B = bets();
      const say = o.progress || (() => {});
      const season = o.season;
      const errors = {};

      say('Reading the schedule and game lines…');
      const [sb, sbPrev] = await Promise.all([src.scoreboard(date), soft(src.scoreboard(B.prevDay(date)))]);
      const games = B.parseScoreboard(sb).filter((g) => g.date === date);
      const playedYesterday = new Set();
      if (sbPrev.ok) B.parseScoreboard(sbPrev.ok).forEach((g) => { playedYesterday.add(g.home.id); playedYesterday.add(g.away.id); });
      if (!games.length) return { date, season, games: [], players: {}, out: [], errors, loadedAt: Date.now() };

      say('Reading DraftKings, Betano and Betclic…');
      const [dkRaw, bnLeague, bcLeague, inj] = await Promise.all([
        Promise.all(games.map((g) => soft(src.props(g.id)))),
        soft(src.betano()),
        soft(src.betclic()),
        soft(src.injuries()),
      ]);
      const bnList = bnLeague.ok ? B.parseBetanoLeague(bnLeague.ok) : [];
      const bcList = bcLeague.ok ? B.parseBetclicLeague(bcLeague.ok) : [];
      if (bnLeague.err) errors.Betano = bnLeague.err.message;
      if (bcLeague.err) errors.Betclic = bcLeague.err.message;
      const [bnEvents, bcEvents] = await Promise.all([
        Promise.all(games.map((g) => { const m = B.matchGame(g, bnList); return m ? soft(src.betanoEvent(m.url)) : Promise.resolve({}); })),
        Promise.all(games.map((g) => { const m = B.matchGame(g, bcList); return m ? soft(src.betclicEvent(m.path)) : Promise.resolve({}); })),
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
        src.players(season, propIds),
        src.gamelogs(season, propIds.concat(outIds)),
        src.gamelogs(season - 1, propIds),
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

    /* What grading needs for some picks: each player's games this season (null when his log could not be
       read) and DraftKings' closing props for each game. */
    async function loadResults(picks, season) {
      const B = bets();
      const athletes = Array.from(new Set(picks.map((r) => String(r.athlete))));
      const events = Array.from(new Set(picks.map((r) => String(r.event))));
      const [logs, props] = await Promise.all([
        athletes.length ? src.gamelogs(season, athletes) : {},
        Promise.all(events.map((ev) => soft(src.props(ev)))),
      ]);
      const rows = {}, closes = {};
      athletes.forEach((id) => { rows[id] = logs[id] ? B.normGamelog(logs[id]) : null; });
      events.forEach((ev, i) => { closes[ev] = props[i].ok ? B.parseEspnProps(props[i].ok) : null; });
      return { rows, closes };
    }

    // The track record on the local server (browser only; tools/picks.js reads the file itself).
    const picks = {
      load: () => get('/picks').then((d) => (d && d.picks) || {}),
      async save(upsert, remove) {
        const r = await doFetch(base + '/picks', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ upsert: upsert || [], remove: remove || [] }) });
        if (!r.ok) {
          let msg = '';
          try { msg = (await r.json()).message; } catch (e) { /* not JSON */ }
          throw new Error(msg || 'Could not save the track record (HTTP ' + r.status + ').');
        }
        return r.json();
      },
    };

    return { loadNight, loadResults, picks, src };
  }

  return { create, betclicState };
});
