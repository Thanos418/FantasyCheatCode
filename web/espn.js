/* Data layer: fetches raw ESPN JSON (via the local proxy, directly, or from demo data)
   and turns it into the inputs WPModel needs. Contract: SPEC.md "Data layer contract". */
(function (root) {
  'use strict';

  const DIRECT_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/';
  const PROBE_TTL_MS = 7 * 24 * 3600 * 1000;
  const MAX_INFLIGHT = 6;
  const FA_STATS = ['002027', '102027', '012027', '022027', '002026'];

  function buildQuery(views, params) {
    const parts = [];
    const add = (k, v) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    (views || []).forEach((v) => add('view', v));
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v == null) return;
      (Array.isArray(v) ? v : [v]).forEach((x) => add(k, x));
    });
    return parts.join('&');
  }

  async function runLimited(items, limit, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  function create(opts) {
    const mode = opts.mode || 'local';
    const L = 'seasons/' + opts.season + '/segments/0/leagues/' + opts.leagueId;
    const M = () => root.WPModel;

    async function get(rel, o) {
      o = o || {};
      const qs = buildQuery(o.views, o.params);
      const ttl = o.ttl == null ? 30 : o.ttl;
      if (mode === 'demo') {
        return root.WPDemo.respond(rel, { views: o.views || [], params: o.params || {}, filter: o.filter || null });
      }
      const headers = {};
      if (o.filter) headers['x-fantasy-filter'] = JSON.stringify(o.filter);
      let url;
      let init;
      if (mode === 'direct') {
        url = DIRECT_BASE + rel + (qs ? '?' + qs : '');
        init = { credentials: 'include', headers };
      } else {
        headers['x-cache-ttl'] = String(ttl);
        url = '/espn/' + rel + (qs ? '?' + qs : '');
        init = { headers };
      }
      let res;
      try { res = await fetch(url, init); } catch (e) {
        const err = new Error('Could not reach ' + (mode === 'direct' ? 'ESPN' : 'the local server') + ': ' + e.message);
        err.status = 0;
        throw err;
      }
      if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch (e) { /* not JSON */ }
        const err = new Error((body && (body.message || body.error)) || 'ESPN answered HTTP ' + res.status);
        err.status = res.status;
        if (body && body.error) err.code = body.error;
        throw err;
      }
      return res.json();
    }

    const teamFilter = (id) => ({ schedule: { filterTeamIds: { value: [id] } } });
    const probeKey = 'wp:probe:' + opts.leagueId + ':' + opts.season;

    function readProbeCache(weeks) {
      try {
        const c = JSON.parse(root.localStorage.getItem(probeKey) || 'null');
        if (c && Date.now() - c.t < PROBE_TTL_MS && c.probe) {
          for (let k = 1; k <= weeks; k++) if (c.probe[k] == null) return null;
          return c.probe;
        }
      } catch (e) { /* storage unavailable */ }
      return null;
    }

    async function loadProbe(myTeamId, league, sched) {
      const m = M();
      const nWeeks = m.calendarWeekOf(sched, league.finalSp);
      const cached = readProbeCache(nWeeks);
      if (cached) return cached;
      const probe = {};
      const ks = Array.from({ length: nWeeks }, (_, i) => i + 1);
      await runLimited(ks, MAX_INFLIGHT, async (k) => {
        const sp = m.calendarWeekSps(sched, k, league.finalSp)[0];
        if (sp == null) return;
        const raw = await get(L, { views: ['mMatchupScore'], params: { scoringPeriodId: sp }, filter: teamFilter(myTeamId), ttl: 86400 });
        const hit = (raw.schedule || []).find((s) =>
          (s.home && s.home.rosterForCurrentScoringPeriod) || (s.away && s.away.rosterForCurrentScoringPeriod));
        if (hit) probe[k] = hit.matchupPeriodId;
      });
      try { root.localStorage.setItem(probeKey, JSON.stringify({ t: Date.now(), probe })); } catch (e) { /* ignore */ }
      return probe;
    }

    async function loadBase() {
      const m = M();
      const leagueRaw = await get(L, { views: ['mSettings', 'mTeam', 'mStatus'], ttl: 300 });
      const myTeamId = opts.teamId || m.detectMyTeam(m.normLeague(leagueRaw), opts.swid);
      if (!myTeamId) throw new Error('Could not tell which team is yours. Set your team ID in the setup form (it is the number in your team page URL).');
      const [schedRaw, proRaw] = await Promise.all([
        get(L, { views: ['mMatchup'], filter: teamFilter(myTeamId), ttl: 60 }),
        get('seasons/' + opts.season, { views: ['proTeamSchedules_wl'], ttl: 43200 }),
      ]);
      const league = m.normLeague(leagueRaw, schedRaw);
      const sched = m.buildProSchedule(proRaw);
      const probe = await loadProbe(myTeamId, league, sched);
      const weeks = m.buildWeeks({ sched, league, probe });
      return { league, sched, weeks, myTeamId };
    }

    async function loadWeek(base, week) {
      const m = M();
      const { league, myTeamId } = base;
      const cur = league.currentSp;
      const m1 = (league.matchups || []).find((x) => x.mp === week.id &&
        ((x.home && x.home.teamId === myTeamId) || (x.away && x.away.teamId === myTeamId)));
      const oppId = m1 ? (m1.home.teamId === myTeamId ? m1.away.teamId : m1.home.teamId) : null;
      const teamIds = oppId != null && oppId !== myTeamId ? [myTeamId, oppId] : [myTeamId];

      const spsToLoad = week.sps.filter((sp) => sp <= cur);
      if (spsToLoad.indexOf(cur) < 0) spsToLoad.push(cur); // future week: current roster only
      const rosterAt = (sp) => get(L, { views: ['mRoster'], params: { scoringPeriodId: sp, rosterForTeamId: teamIds }, ttl: sp < cur ? 3600 : 60 });
      const wantFa = week.last >= cur;

      const [rawBySp, faRaw, txRaw] = await Promise.all([
        Promise.all(spsToLoad.map(rosterAt)),
        wantFa ? get(L, {
          views: ['kona_player_info'], params: { scoringPeriodId: cur }, ttl: 300,
          filter: {
            players: {
              filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
              filterSlotIds: { value: [0, 1, 2, 3, 4, 5, 6, 11] },
              sortPercOwned: { sortPriority: 1, sortAsc: false },
              limit: 250,
              filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: FA_STATS },
            },
          },
        }) : null,
        wantFa ? get(L, { views: ['mTransactions2'], params: { scoringPeriodId: cur }, ttl: 60 }) : null,
      ]);

      const rosters = {};
      teamIds.forEach((id) => { rosters[id] = { current: [], bySp: {} }; });
      spsToLoad.forEach((sp, i) => {
        (rawBySp[i].teams || []).forEach((t) => {
          const r = rosters[t.id];
          if (!r) return;
          const players = ((t.roster && t.roster.entries) || []).map((e) => m.normPlayer(e));
          if (sp <= cur && week.sps.indexOf(sp) >= 0) r.bySp[sp] = players;
          if (sp === cur) r.current = players;
        });
      });

      const demo = mode === 'demo';
      return {
        league, sched: base.sched, week, myTeamId,
        now: demo ? root.WPDemo.now : Date.now(),
        factors: root.WPFactors || null,
        rosters,
        freeAgents: faRaw ? (faRaw.players || []).map((e) => m.normPlayer(e)) : [],
        transactions: txRaw ? txRaw.transactions || [] : [],
      };
    }

    function clearCache() { try { root.localStorage.removeItem(probeKey); } catch (e) { /* ignore */ } }

    return { mode, get, loadBase, loadWeek, clearCache };
  }

  root.WPData = { create };
})(typeof self !== 'undefined' ? self : globalThis);
