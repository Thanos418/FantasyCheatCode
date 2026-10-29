(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WPModel = api; // also when a host page (e.g. ESPN) has its own global `module`
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  const SLOT_NAMES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'SG/SF', 'G/F', 'PF/C', 'F/C', 'UTIL', 'BN', 'IR'];
  const STARTING_EXCLUDE = [12, 13];
  const OUT_STATUSES = ['OUT', 'INJURY_RESERVE', 'SUSPENSION'];
  const STAT = { PTS: 0, BLK: 1, STL: 2, AST: 3, OREB: 4, DREB: 5, REB: 6, TO: 11, FGM: 13, FGA: 14, FTM: 15, FTA: 16, TPM: 17, TPA: 18, MIN: 40, GS: 41, GP: 42 };
  const POS_NAMES = ['PG', 'SG', 'SF', 'PF', 'C'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const LIVE_WINDOW_MS = 3.5 * 3600 * 1000;

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const isOut = (p) => OUT_STATUSES.indexOf(p.injury) >= 0;

  /* --------------------------------------------------------------- dates */

  let etFmt = null;
  function etDate(ms) {
    if (!etFmt) etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    const o = {};
    etFmt.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  function parseDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  }
  function fmtDate(dt) {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
  }
  function addDays(d, n) { const dt = parseDate(d); dt.setUTCDate(dt.getUTCDate() + n); return fmtDate(dt); }
  function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / 86400000); }
  function weekdayOf(d) { return parseDate(d).getUTCDay(); }
  function fmtRange(d1, d2) {
    const a = parseDate(d1), b = parseDate(d2);
    const left = MONTHS[a.getUTCMonth()] + ' ' + a.getUTCDate();
    const right = (a.getUTCMonth() === b.getUTCMonth() ? '' : MONTHS[b.getUTCMonth()] + ' ') + b.getUTCDate();
    return left + ' – ' + right;
  }

  /* -------------------------------------------------------------- league */

  function normLeague(raw, schedRaw) {
    raw = raw || {};
    const st = raw.settings || {};
    const rs = st.rosterSettings || {};
    const ss = st.scheduleSettings || {};
    const acq = st.acquisitionSettings || {};
    const status = raw.status || {};
    const counts = rs.lineupSlotCounts || {};
    const caps = {};
    let starters = 0;
    Object.keys(counts).forEach((k) => {
      const s = +k, c = +counts[k] || 0;
      if (STARTING_EXCLUDE.indexOf(s) >= 0 || c <= 0) return;
      caps[k] = c; starters += c;
    });
    const scoringType = (st.scoringSettings && st.scoringSettings.scoringType) || '';
    const teams = {};
    (raw.teams || []).forEach((t) => {
      const ov = (t.record && t.record.overall) || {};
      const nm = (t.name || ((t.location || '') + ' ' + (t.nickname || ''))).trim();
      teams[t.id] = {
        id: t.id, name: nm, abbrev: t.abbrev || '', owners: (t.owners || []).map((o) => (typeof o === 'string' ? o : o && o.id)).filter(Boolean),
        logo: t.logo || null, record: { wins: ov.wins || 0, losses: ov.losses || 0, ties: ov.ties || 0 },
        addsByMp: (t.transactionCounter && t.transactionCounter.matchupAcquisitionTotals) || {},
      };
    });
    const side = (s) => (s ? { teamId: s.teamId, total: s.totalPoints != null ? s.totalPoints : (s.total != null ? s.total : 0), bySp: s.pointsByScoringPeriod || {} } : null);
    const src = schedRaw && schedRaw.schedule ? schedRaw.schedule : (raw.schedule || []);
    const matchups = src.map((m) => ({ mp: m.matchupPeriodId, home: side(m.home), away: side(m.away) }));
    return {
      id: raw.id, season: raw.seasonId, name: st.name || '', size: st.size || Object.keys(teams).length, scoringType,
      isPoints: /POINTS/i.test(scoringType),
      caps, starters, benchCount: +counts[12] || 0, irCount: +counts[13] || 0,
      acq: { limit: acq.matchupAcquisitionLimit != null ? acq.matchupAcquisitionLimit : -1, perDay: !!acq.matchupLimitPerScoringPeriod },
      matchupPeriods: ss.matchupPeriods || {}, regularCount: ss.matchupPeriodCount || 0,
      currentSp: status.latestScoringPeriod != null ? status.latestScoringPeriod : raw.scoringPeriodId,
      currentMp: status.currentMatchupPeriod != null ? status.currentMatchupPeriod : null,
      firstSp: status.firstScoringPeriod != null ? status.firstScoringPeriod : 1,
      finalSp: status.finalScoringPeriod != null ? status.finalScoringPeriod : null,
      teams, matchups,
    };
  }

  function detectMyTeam(league, swid) {
    if (!swid || !league) return null;
    const norm = (s) => String(s).replace(/[{}]/g, '').trim().toLowerCase();
    const want = norm(swid);
    const ids = Object.keys(league.teams || {});
    for (let i = 0; i < ids.length; i++) {
      const t = league.teams[ids[i]];
      if ((t.owners || []).some((o) => norm(o) === want)) return t.id;
    }
    return null;
  }

  /* ------------------------------------------------------- pro schedule */

  function buildProSchedule(proRaw) {
    const teams = {}, games = {}, gamesBySp = {}, byTeam = {};
    const pts = (proRaw && proRaw.settings && proRaw.settings.proTeams) || [];
    pts.forEach((t) => {
      if (!t || t.id === 0) return;
      teams[t.id] = { id: t.id, abbrev: t.abbrev, name: ((t.location || '') + ' ' + (t.name || '')).trim() };
      byTeam[t.id] = byTeam[t.id] || {};
      const bysp = t.proGamesByScoringPeriod || {};
      Object.keys(bysp).forEach((k) => {
        const sp = +k;
        (bysp[k] || []).forEach((g) => {
          if (games[g.id]) return;
          const gg = { id: g.id, sp, date: g.date, home: g.homeProTeamId, away: g.awayProTeamId, tbd: !!g.startTimeTBD };
          games[g.id] = gg;
          (gamesBySp[sp] = gamesBySp[sp] || []).push(gg);
        });
      });
    });
    Object.keys(games).forEach((id) => {
      const g = games[id];
      [g.home, g.away].forEach((t) => { (byTeam[t] = byTeam[t] || {})[g.sp] = g.id; });
    });
    const votes = {};
    let best = null, bestN = 0;
    Object.keys(games).forEach((id) => {
      const g = games[id];
      if (!isNum(g.date)) return;
      const sd = addDays(etDate(g.date), -(g.sp - 1));
      votes[sd] = (votes[sd] || 0) + 1;
      if (votes[sd] > bestN) { bestN = votes[sd]; best = sd; }
    });
    return { startDate: best, teams, games, gamesBySp, byTeam };
  }

  function teamGame(sched, proId, sp) {
    const bt = sched.byTeam && sched.byTeam[proId];
    const gid = bt && bt[sp];
    return gid != null ? sched.games[gid] || null : null;
  }
  function spDate(sched, sp) { return addDays(sched.startDate, sp - 1); }
  function dateSp(sched, d) { return diffDays(d, sched.startDate) + 1; }
  function calOffset(sched) { return (weekdayOf(sched.startDate) + 6) % 7; }
  function calendarWeekOf(sched, sp) { return Math.floor((sp - 1 + calOffset(sched)) / 7) + 1; }
  function calendarWeekSps(sched, k, finalSp) {
    const off = calOffset(sched);
    const first = Math.max(1, 7 * (k - 1) - off + 1);
    const last = Math.min(finalSp, 7 * k - off);
    const out = [];
    for (let s = first; s <= last; s++) out.push(s);
    return out;
  }

  /* --------------------------------------------------------------- weeks */

  function buildWeeks(args) {
    const sched = args.sched, league = args.league, probe = args.probe || {};
    const mps = league.matchupPeriods || {};
    const regular = league.regularCount || 0;
    const finalSp = league.finalSp;
    let keys = Object.keys(mps).map(Number).sort((a, b) => a - b);
    if (!keys.length) { for (let m = 1; m <= regular; m++) keys.push(m); }
    const idsOf = (m) => (mps[m] && mps[m].length ? mps[m].map(Number) : [m]);
    const calMap = {};
    for (let m = 1; m <= regular; m++) {
      const C = Object.keys(probe).filter((k) => +probe[k] === m).map(Number).sort((a, b) => a - b);
      if (!C.length) continue;
      const ids = idsOf(m);
      if (ids.length === 1) calMap[ids[0]] = C.slice();
      else if (ids.length === C.length) ids.forEach((id, i) => { calMap[id] = [C[i]]; });
      else { calMap[ids[0]] = C.slice(); }
    }
    const allIds = [];
    keys.forEach((m) => idsOf(m).forEach((id) => { if (allIds.indexOf(id) < 0) allIds.push(id); }));
    allIds.sort((a, b) => a - b);
    let lastU = null, lastC = null;
    allIds.forEach((u) => {
      if (calMap[u]) { lastU = u; lastC = Math.max.apply(null, calMap[u]); return; }
      calMap[u] = [lastU == null ? u : lastC + (u - lastU)];
    });
    const weeks = [];
    keys.forEach((m) => {
      const cw = [];
      idsOf(m).forEach((id) => (calMap[id] || []).forEach((c) => { if (cw.indexOf(c) < 0) cw.push(c); }));
      cw.sort((a, b) => a - b);
      const sps = [];
      cw.forEach((c) => calendarWeekSps(sched, c, finalSp).forEach((s) => { if (sps.indexOf(s) < 0) sps.push(s); }));
      if (!sps.length) return;
      sps.sort((a, b) => a - b);
      const playoff = m > regular;
      weeks.push({
        id: m, sps, first: sps[0], last: sps[sps.length - 1], calWeeks: cw, playoff, long: sps.length > 7,
        label: playoff ? 'Playoffs · round ' + (m - regular) : 'Week ' + m,
        range: fmtRange(spDate(sched, sps[0]), spDate(sched, sps[sps.length - 1])),
      });
    });
    return weeks;
  }

  /* ------------------------------------------------------------- players */

  function normPlayer(entry) {
    entry = entry || {};
    const isRoster = !!entry.playerPoolEntry;
    const pl = (isRoster ? entry.playerPoolEntry.player : entry.player) || {};
    const eligible = pl.eligibleSlots || [];
    let posList = POS_NAMES.filter((n, i) => eligible.indexOf(i) >= 0);
    if (!posList.length && pl.defaultPositionId >= 1 && pl.defaultPositionId <= 5) posList = [POS_NAMES[pl.defaultPositionId - 1]];
    const own = pl.ownership || {};
    const first = pl.firstName || '', last = pl.lastName || '';
    let status;
    if (isRoster) status = 'ONTEAM';
    else status = entry.status || (entry.onTeamId ? 'ONTEAM' : 'FREEAGENT');
    return {
      id: isRoster ? (entry.playerId != null ? entry.playerId : pl.id) : (entry.id != null ? entry.id : pl.id),
      name: pl.fullName || (first + ' ' + last).trim(), first, last,
      proTeamId: pl.proTeamId, posId: pl.defaultPositionId, pos: posList.join('/'), eligible,
      // Live ESPN roster entries say 'NORMAL' while the player carries the real status (OUT, DAY_TO_DAY, ...).
      injury: [pl.injuryStatus, isRoster ? entry.injuryStatus : null].find((x) => x && x !== 'ACTIVE' && x !== 'NORMAL') || 'ACTIVE',
      slot: isRoster && entry.lineupSlotId != null ? entry.lineupSlotId : null,
      status, waiverDate: !isRoster && entry.waiverProcessDate ? entry.waiverProcessDate : null,
      own: { pct: own.percentOwned != null ? own.percentOwned : null, chg: own.percentChange != null ? own.percentChange : null },
      stats: pl.stats || [],
    };
  }

  function gameStat(player, sp) {
    const st = (player && player.stats) || [];
    for (let i = 0; i < st.length; i++) {
      const e = st[i];
      if (e && e.statSplitTypeId === 5 && e.statSourceId === 0 && e.scoringPeriodId === sp) return e;
    }
    return null;
  }

  function boxOf(e) {
    const s = (e && e.stats) || {};
    const g = (k) => (s[k] != null ? s[k] : null);
    return { pts: g(0), reb: g(6), ast: g(3), stl: g(2), blk: g(1), to: g(11), min: g(40), fgm: g(13), fga: g(14), tpm: g(17) };
  }

  function projectPlayer(player, season, isPoints) {
    if (isPoints === undefined) isPoints = true;
    const stats = (player && player.stats) || [];
    const find = (id) => { for (let i = 0; i < stats.length; i++) if (stats[i] && String(stats[i].id) === id) return stats[i]; return null; };
    const gp = (e) => (e && e.stats && e.stats[42]) || 0;
    const avg = (e) => {
      if (!e) return null;
      if (e.appliedAverage) return e.appliedAverage;
      return gp(e) ? e.appliedTotal / gp(e) : null;
    };
    const cur = find('00' + season), proj = find('10' + season), prev = find('00' + (season - 1)), l15 = find('02' + season);
    const n = gp(cur);
    const curAvg = n ? avg(cur) : null;
    const pj = avg(proj), pv = avg(prev);
    const prior = pj != null ? pj : pv;
    let fp;
    if (prior == null) fp = curAvg != null ? curAvg : (avg(l15) != null ? avg(l15) : 0);
    else if (curAvg == null) fp = prior;
    else fp = (n / (n + 10)) * curAvg + (10 / (n + 10)) * prior;
    if (!isPoints) fp = 1;
    return { fp, curAvg, n, prior, espnProj: pj, l15: avg(l15), l15n: gp(l15), prevAvg: pv };
  }

  /* -------------------------------------------------------------- lineup */

  function bestLineup(cands, caps) {
    const inst = [];
    Object.keys(caps || {}).forEach((k) => {
      const s = +k;
      if (STARTING_EXCLUDE.indexOf(s) >= 0) return;
      for (let i = 0; i < caps[k]; i++) inst.push(s);
    });
    const order = cands.map((c, i) => i).sort((a, b) => (cands[b].w - cands[a].w) || (a - b));
    const owner = new Array(inst.length).fill(-1);
    const adj = cands.map((c) => {
      const set = c.slots || [];
      const a = [];
      for (let j = 0; j < inst.length; j++) if (set.indexOf(inst[j]) >= 0) a.push(j);
      return a;
    });
    let seen = null;
    function aug(ci) {
      const a = adj[ci];
      for (let t = 0; t < a.length; t++) {
        const j = a[t];
        if (seen[j]) continue;
        seen[j] = 1;
        if (owner[j] < 0 || aug(owner[j])) { owner[j] = ci; return true; }
      }
      return false;
    }
    let filled = 0;
    for (let o = 0; o < order.length && filled < inst.length; o++) {
      const ci = order[o];
      if (!adj[ci].length) continue;
      seen = new Array(inst.length).fill(0);
      if (aug(ci)) filled++;
    }
    const matched = new Set();
    const slotOf = new Map();
    owner.forEach((ci, j) => { if (ci >= 0) { matched.add(ci); slotOf.set(cands[ci].key, inst[j]); } });
    const chosen = order.filter((ci) => matched.has(ci)).map((ci) => cands[ci]);
    let total = 0;
    chosen.forEach((c) => { total += c.w; });
    return { chosen, total, slotOf };
  }

  /* ---------------------------------------------------------- computeWeek */

  // Expected points multiplier for one game: venue, opponent and the second night of a back-to-back
  // (output and chance of playing). factors = WPFactors or null (then mult 1). play = chance of playing.
  function gameMult(sched, factors, proTeamId, sp) {
    const g = factors && teamGame(sched, proTeamId, sp);
    if (!g) return { mult: 1, b2b: false, play: 1 };
    const home = g.home === proTeamId;
    const b2b = !!teamGame(sched, proTeamId, sp - 1);
    const t = sched.teams[home ? g.away : g.home];
    const opp = (factors.opp && t && factors.opp[t.abbrev]) || 1;
    const play = b2b ? factors.b2bPlay : 1;
    return { mult: (home ? factors.home : factors.away) * opp * (b2b ? factors.b2bOutput : 1) * play, b2b, play };
  }

  function computeWeek(ctx) {
    const league = ctx.league, sched = ctx.sched, week = ctx.week, now = ctx.now, me = ctx.myTeamId;
    const caps = league.caps;
    const cur = league.currentSp;
    const isPoints = league.isPoints !== false;
    const season = league.season;
    const rosters = ctx.rosters || {};
    const sps = week.sps;
    const kindOf = (sp) => (sp < cur ? 'past' : sp === cur ? 'today' : 'future');
    const projCache = new Map();
    const projOf = (p) => {
      let v = projCache.get(p);
      if (!v) { v = projectPlayer(p, season, isPoints); projCache.set(p, v); }
      return v;
    };
    const unstarted = (g) => !!g && !(isNum(g.date) && g.date <= now);
    const unstartedGame = (p, sp) => { const g = teamGame(sched, p.proTeamId, sp); return unstarted(g) ? g : null; };
    const abbrOf = (id) => (sched.teams[id] && sched.teams[id].abbrev) || '';
    const F = isPoints ? ctx.factors : null;
    const gameFactor = (p, sp) => gameMult(sched, F, p.proTeamId, sp);
    const expFp = (p, sp) => projOf(p).fp * gameFactor(p, sp).mult;
    const toCand = (p, sp) => ({ key: String(p.id), w: expFp(p, sp), slots: p.eligible || [] });
    const oppInfo = (g, proId) => { const home = g.home === proId; return { opp: abbrOf(home ? g.away : g.home), home }; };
    const reduceCaps = (used) => {
      const c = {};
      Object.keys(caps).forEach((k) => { c[k] = Math.max(0, caps[k] - (used[k] || 0)); });
      return c;
    };

    // ---- days
    const days = sps.map((sp) => {
      const date = spDate(sched, sp);
      const gs = sched.gamesBySp[sp] || [];
      const dts = gs.map((g) => g.date).filter(isNum);
      const n = gs.length;
      return {
        sp, date, dow: DOWS[weekdayOf(date)], dom: +date.slice(8, 10), kind: kindOf(sp), nGames: n,
        firstTip: dts.length ? Math.min.apply(null, dts) : null, light: n <= 5, heavy: n >= 11,
      };
    });

    // ---- games per team
    const gpt = {};
    Object.keys(sched.teams).forEach((id) => {
      let n = 0;
      sps.forEach((sp) => { if (sched.byTeam[id] && sched.byTeam[id][sp] != null) n++; });
      (gpt[n] = gpt[n] || []).push({ id: +id, abbrev: sched.teams[id].abbrev });
    });
    const gamesPerTeam = Object.keys(gpt).map(Number).sort((a, b) => b - a).map((c) => ({
      count: c, teams: gpt[c].sort((a, b) => (a.abbrev < b.abbrev ? -1 : a.abbrev > b.abbrev ? 1 : 0)),
    }));

    // ---- matchup / opponent
    const matchup = (league.matchups || []).find((m) => m.mp === week.id && ((m.home && m.home.teamId === me) || (m.away && m.away.teamId === me)));
    let oppId = null;
    if (matchup) {
      const o = matchup.home && matchup.home.teamId === me ? matchup.away : matchup.home;
      oppId = o ? o.teamId : null;
    }

    const slotOrder = (r) => (r.gone ? 200 : r.player.slot === 12 ? 100 : r.player.slot === 13 ? 101 : r.player.slot == null ? 99 : r.player.slot);

    // ---- team computation
    function teamWeek(teamId) {
      const R = rosters[teamId] || { current: [], bySp: {} };
      const current = R.current || [];
      const bySp = R.bySp || {};
      const curIds = new Set(current.map((p) => p.id));
      const rows = new Map();
      const rowFor = (p) => {
        let r = rows.get(p.id);
        if (!r) { r = { player: p, cells: {}, gone: !curIds.has(p.id) }; rows.set(p.id, r); }
        return r;
      };
      current.forEach(rowFor);
      const dayOut = {};
      let todayCaps = null;

      function futureDay(sp, capsX, info) {
        const cands = [];
        current.forEach((p) => {
          const g = unstartedGame(p, sp);
          if (!g) return;
          if (p.slot !== 13 && !isOut(p)) cands.push(toCand(p, sp));
        });
        const res = bestLineup(cands, capsX);
        const chosen = new Set(res.chosen.map((c) => c.key));
        current.forEach((p) => {
          const g = unstartedGame(p, sp);
          if (!g) return;
          const oi = oppInfo(g, p.proTeamId);
          const out = isOut(p);
          rowFor(p).cells[sp] = {
            t: 'proj', fp: expFp(p, sp), opp: oi.opp, home: oi.home, b2b: gameFactor(p, sp).b2b,
            start: !out && p.slot !== 13 && chosen.has(String(p.id)), out, dtd: p.injury === 'DAY_TO_DAY', tip: g.date,
          };
        });
        info.remaining = res.chosen.length;
        info.remProj = res.total;
      }

      sps.forEach((sp) => {
        const kind = kindOf(sp);
        const info = { played: 0, playedPts: 0, remaining: 0, remProj: 0, withGame: 0, open: null };
        dayOut[sp] = info;
        if (kind === 'future') {
          current.forEach((p) => { if (p.slot !== 13 && teamGame(sched, p.proTeamId, sp)) info.withGame++; });
          futureDay(sp, caps, info);
        } else {
          const rl = bySp[sp] || current;
          const rlIds = new Set(rl.map((p) => p.id));
          const used = {};
          rl.forEach((p) => {
            const g = teamGame(sched, p.proTeamId, sp);
            if (!g) return;
            if (p.slot !== 13) info.withGame++;
            const started = isNum(g.date) ? g.date <= now : true;
            if (kind === 'today' && !started) return;
            const oi = oppInfo(g, p.proTeamId);
            const active = p.slot !== 12 && p.slot !== 13;
            const why = active ? null : p.slot === 13 ? 'ir' : 'bench';
            const stat = gameStat(p, sp);
            const didPlay = !!(stat && stat.stats && stat.stats[42] > 0);
            const live = kind === 'today' && isNum(g.date) && now - g.date < LIVE_WINDOW_MS;
            const row = rowFor(p);
            if (didPlay || (kind === 'today' && live && active && !isOut(p) && !stat)) {
              const fp = stat ? stat.appliedTotal : null;
              row.cells[sp] = { t: 'played', fp, counted: active, why, opp: oi.opp, home: oi.home, live: kind === 'today' && live, box: stat ? boxOf(stat) : null };
              if (active) {
                info.played++; info.playedPts += fp || 0;
                if (p.slot != null) used[p.slot] = (used[p.slot] || 0) + 1;
              }
            } else {
              row.cells[sp] = { t: 'dnp', opp: oi.opp, home: oi.home, why: isOut(p) ? 'out' : 'dnp' };
            }
          });
          if (bySp[sp]) {
            current.forEach((p) => {
              if (rlIds.has(p.id)) return;
              const g = teamGame(sched, p.proTeamId, sp);
              if (!g) return;
              if (kind === 'today' && unstarted(g)) return;
              const oi = oppInfo(g, p.proTeamId);
              const stat = gameStat(p, sp);
              rowFor(p).cells[sp] = { t: 'played', fp: stat ? stat.appliedTotal : null, counted: false, why: 'away', opp: oi.opp, home: oi.home, live: false, box: stat ? boxOf(stat) : null };
            });
          }
          if (kind === 'today') {
            todayCaps = reduceCaps(used);
            futureDay(sp, todayCaps, info);
          }
        }
        info.open = kind === 'past' ? null : Math.max(0, league.starters - info.played - info.remaining);
      });

      const out = {
        rows: [], days: dayOut, played: 0, remaining: 0, remProj: 0, todayCaps,
        current,
      };
      rows.forEach((r) => {
        r.proj = projOf(r.player);
        let soFar = 0, rest = 0, games = 0;
        Object.keys(r.cells).forEach((k) => {
          const c = r.cells[k];
          if (c.t === 'played' && c.counted) { soFar += c.fp || 0; games++; }
          else if (c.t === 'proj' && c.start) { rest += c.fp; games++; }
        });
        r.soFar = soFar; r.rest = rest; r.total = soFar + rest; r.games = games;
        out.rows.push(r);
      });
      out.rows.sort((a, b) => (slotOrder(a) - slotOrder(b)) || (b.proj.fp - a.proj.fp));
      sps.forEach((sp) => { out.played += dayOut[sp].played; out.remaining += dayOut[sp].remaining; out.remProj += dayOut[sp].remProj; });
      return out;
    }

    function finishTeam(teamId, tw) {
      const t = league.teams[teamId] || {};
      let playedPts = 0;
      sps.forEach((sp) => { playedPts += tw.days[sp].playedPts; });
      let actual = playedPts;
      if (matchup) {
        const s = matchup.home && matchup.home.teamId === teamId ? matchup.home : matchup.away && matchup.away.teamId === teamId ? matchup.away : null;
        if (s && s.bySp) {
          const has = sps.filter((sp) => s.bySp[sp] != null);
          if (has.length) actual = has.reduce((a, sp) => a + s.bySp[sp], 0);
        }
      }
      return {
        teamId, name: t.name || ('Team ' + teamId), abbrev: t.abbrev || '', days: tw.days,
        played: tw.played, remaining: tw.remaining, total: tw.played + tw.remaining,
        actual, remProj: tw.remProj, projFinal: actual + tw.remProj, rows: tw.rows,
      };
    }

    const myRaw = teamWeek(me);
    const meTW = finishTeam(me, myRaw);
    let oppTW = null;
    if (oppId != null) oppTW = finishTeam(oppId, teamWeek(oppId));

    // ---- adds
    const txs = ctx.transactions || [];
    const isAcq = (t) => t.type === 'FREEAGENT' || t.type === 'WAIVER';
    const addItems = (t) => (t.items || []).filter((i) => i.type === 'ADD');
    const mine = txs.filter((t) => t.teamId === me && isAcq(t));
    const executed = mine.filter((t) => t.status === 'EXECUTED' && addItems(t).length);
    const spSet = new Set(sps);
    let txUsed = 0, todayUsed = 0;
    executed.forEach((t) => {
      const n = addItems(t).length;
      if (spSet.has(t.scoringPeriodId)) txUsed += n;
      if (t.scoringPeriodId === cur) todayUsed += n;
    });
    const espnUsed = (league.teams[me] && league.teams[me].addsByMp && league.teams[me].addsByMp[week.id]) || 0;
    const used = Math.max(txUsed, espnUsed);
    const lim = league.acq.limit;
    const weekLimit = lim > 0 ? (league.acq.perDay ? lim * sps.length : lim) : null;
    const nameById = new Map();
    const remember = (p) => { if (p && !nameById.has(p.id)) nameById.set(p.id, { id: p.id, name: p.name }); };
    Object.keys(rosters).forEach((k) => {
      (rosters[k].current || []).forEach(remember);
      Object.keys(rosters[k].bySp || {}).forEach((s) => rosters[k].bySp[s].forEach(remember));
    });
    (ctx.freeAgents || []).forEach(remember);
    const nm = (id) => nameById.get(id) || { id, name: 'Player ' + id };
    const pending = [];
    mine.filter((t) => t.status === 'PENDING').forEach((t) => {
      const drops = (t.items || []).filter((i) => i.type === 'DROP');
      addItems(t).forEach((a, i) => pending.push({ add: nm(a.playerId), drop: drops[i] ? nm(drops[i].playerId) : null }));
    });
    const adds = { used, weekLimit, perDay: league.acq.perDay, limit: lim, todayUsed, pending };

    // ---- recommendations
    const recs = { byDay: {}, board: [], note: null };
    const remDays = sps.filter((sp) => kindOf(sp) !== 'past');
    const faAll = ctx.freeAgents || [];
    if (remDays.length && myRaw.current.length) {
      if (weekLimit != null && used >= weekLimit) {
        recs.note = 'You have used all ' + weekLimit + ' adds for this week.';
        remDays.forEach((sp) => { recs.byDay[sp] = []; });
      } else {
        computeRecs();
      }
    }

    function computeRecs() {
      const roster = myRaw.current.filter((p) => p.slot !== 13);
      const capsFor = (sp) => (sp === cur && myRaw.todayCaps ? myRaw.todayCaps : caps);
      const baseCands = {}, baseRes = {}, baseV = {}, baseChosen = {};
      remDays.forEach((sp) => {
        baseCands[sp] = roster.filter((p) => !isOut(p) && unstartedGame(p, sp)).map((p) => toCand(p, sp));
        baseRes[sp] = bestLineup(baseCands[sp], capsFor(sp));
        baseV[sp] = baseRes[sp].total;
        baseChosen[sp] = new Set(baseRes[sp].chosen.map((c) => c.key));
      });
      const dropCands = roster.slice().sort((a, b) => projOf(a).fp - projOf(b).fp).slice(0, 4);
      const options = dropCands.slice();
      if (roster.length < league.starters + league.benchCount) options.push(null);

      const minAdd = (cur >= remDays[0] && league.acq.perDay && lim > 0 && todayUsed >= lim) ? cur + 1 : -Infinity;
      const pool = [];
      faAll.forEach((f) => {
        if (isOut(f)) return;
        const gd = remDays.filter((sp) => unstartedGame(f, sp));
        if (!gd.length) return;
        pool.push({ f, gd, score: gd.reduce((t, sp) => t + expFp(f, sp), 0) });
      });
      pool.sort((a, b) => b.score - a.score);
      const top = pool.slice(0, 80);

      const byDayAll = {};
      remDays.forEach((sp) => { byDayAll[sp] = []; });
      const board = [];

      top.forEach((e) => {
        const f = e.f;
        const fc = {};
        let avail = -Infinity;
        if (f.status === 'WAIVERS') avail = f.waiverDate ? dateSp(sched, etDate(f.waiverDate)) : cur;
        const from = Math.max(avail, minAdd);
        const fGame = {};
        remDays.forEach((sp) => { fGame[sp] = !!unstartedGame(f, sp); if (fGame[sp]) fc[sp] = toCand(f, sp); });
        let fBest = null;
        const perOpt = options.map((r) => {
          const rKey = r ? String(r.id) : null;
          const delta = {}, fCh = {}, lineups = {};
          remDays.forEach((sp) => {
            let arr = rKey == null ? baseCands[sp] : baseCands[sp].filter((c) => c.key !== rKey);
            if (fGame[sp]) arr = arr.concat([fc[sp]]);
            const res = fGame[sp] || (rKey != null && baseChosen[sp].has(rKey)) ? bestLineup(arr, capsFor(sp)) : baseRes[sp];
            delta[sp] = res.total - baseV[sp];
            fCh[sp] = fGame[sp] && res.chosen.some((c) => c.key === fc[sp].key);
            lineups[sp] = res;
          });
          return { r, rKey, delta, fCh, lineups };
        });
        remDays.forEach((d) => {
          if (!fGame[d] || d < from) return;
          let best = null;
          perOpt.forEach((o) => {
            let gain = 0, reach = 0, lost = 0;
            remDays.forEach((s) => {
              if (s < d) return;
              gain += o.delta[s];
              if (o.fCh[s]) reach++;
              if (o.rKey != null && baseChosen[s].has(o.rKey)) lost++;
            });
            if (!best || gain > best.gain + 1e-9) best = { o, gain, reach, lost };
          });
          if (!best) return;
          const rec = {
            sp: d, fa: f, faProj: projOf(f), drop: best.o.r, dropProj: best.o.r ? projOf(best.o.r) : null,
            gain: best.gain, gamesReach: best.reach, gamesLost: best.lost,
            upgrade: best.o.r ? projOf(f).fp >= projOf(best.o.r).fp : true, waiver: f.status === 'WAIVERS',
          };
          byDayAll[d].push(rec);
          if (!fBest || rec.gain > fBest.rec.gain + 1e-9) fBest = { rec, o: best.o };
        });
        if (fBest && fBest.rec.gain > 0) {
          const dmap = {};
          remDays.forEach((s) => {
            if (s < fBest.rec.sp || !fGame[s]) return;
            dmap[s] = fBest.o.fCh[s] ? 'start' : 'squeezed';
          });
          board.push({
            fa: f, faProj: fBest.rec.faProj, gamesLeft: e.gd.length, days: dmap, bestSp: fBest.rec.sp,
            drop: fBest.rec.drop, gain: fBest.rec.gain, upgrade: fBest.rec.upgrade,
          });
        }
      });
      remDays.forEach((d) => {
        recs.byDay[d] = byDayAll[d].filter((r) => r.gain > 0.5).sort((a, b) => b.gain - a.gain).slice(0, 3);
      });
      board.sort((a, b) => b.gain - a.gain);
      recs.board = board.slice(0, 25);
    }

    return {
      week, now, isPoints, days, gamesPerTeam, me: meTW, opp: oppTW, adds, recs,
    };
  }

  return {
    SLOT_NAMES, STARTING_EXCLUDE, OUT_STATUSES, STAT,
    etDate, addDays, diffDays, weekdayOf, fmtRange,
    normLeague, detectMyTeam, buildProSchedule, teamGame, spDate, dateSp, calendarWeekOf, calendarWeekSps,
    buildWeeks, normPlayer, gameStat, boxOf, projectPlayer, bestLineup, gameMult, computeWeek,
  };
});
