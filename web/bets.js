/* Bets: prices NBA player props. Pure functions, no DOM, no network.

   For each player and stat it projects a mean from this season's games (recent games count more),
   last season as a prior, and the game in front of him (opponent by position, venue, back-to-back,
   the game total and the spread). The market's own mean comes from DraftKings' two-way line with the
   bookmaker margin removed. The final mean moves from the market's towards the model's by a weight
   fitted on real closing lines (tools/backtest_props.js), and a negative binomial turns it into a
   chance for every line any book offers. A bet is worth it when that chance times the decimal odds
   is above 1. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WPBets = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  /* ------------------------------------------------------------- markets */

  const BASE = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk'];
  const MARKETS = {
    pts: { label: 'Points', short: 'PTS', parts: ['pts'] },
    reb: { label: 'Rebounds', short: 'REB', parts: ['reb'] },
    ast: { label: 'Assists', short: 'AST', parts: ['ast'] },
    tpm: { label: '3-pointers made', short: '3PM', parts: ['tpm'] },
    stl: { label: 'Steals', short: 'STL', parts: ['stl'] },
    blk: { label: 'Blocks', short: 'BLK', parts: ['blk'] },
    pr: { label: 'Points + rebounds', short: 'P+R', parts: ['pts', 'reb'] },
    pa: { label: 'Points + assists', short: 'P+A', parts: ['pts', 'ast'] },
    ra: { label: 'Rebounds + assists', short: 'R+A', parts: ['reb', 'ast'] },
    pra: { label: 'Points + rebounds + assists', short: 'PRA', parts: ['pts', 'reb', 'ast'] },
  };
  const MARKET_IDS = Object.keys(MARKETS);
  const statOf = (row, m) => MARKETS[m].parts.reduce((s, k) => s + (row[k] || 0), 0);
  const GROUP_NAME = { G: 'guards', F: 'forwards', C: 'centers' };

  /* Fitted by tools/backtest_props.js. Rates, minutes, opponent, game total, blowout and spread:
     2025-26 games with 2024-25 as the prior, checked on 2024-25. Over correction and market weights:
     16,146 DraftKings closing lines from 21 Oct to 16 Nov 2026. */
  const DEFAULTS = {
    halfLife: 25, // games: a game's weight in the per-minute rates halves every this many games back
    minHalfLife: 3, // the same for minutes, which follow role changes much faster
    priorGames: 8, // last season counts as this many games in the rates
    priorMinGames: 1, // and as this many in the minutes
    rookieGames: 4, // a player with no last season: his position's average rates count this much
    minGames: 3, // fewer games this season and he gets no projection
    alpha: { pts: 0.5, reb: 0.5, ast: 0.5, tpm: 0.5, stl: 0.5, blk: 1 }, // strength of the opponent factor
    beta: { pts: 0.25, reb: 0.5, ast: 0.5, tpm: 0.25, stl: 0, blk: 1 }, // strength of the game total
    blowFrom: 10, // points of spread before starters are expected to lose minutes
    gamma: 0.005, // minutes lost per point of spread beyond that
    blowMin: 26, // only players projected for this many minutes or more
    // Around the market's mean: variance = a × mean + b × mean², and the cut to rungs above it.
    disp: {
      pts: [3.409, 0, 0.2], reb: [1.187, 0.015, 0.05], ast: [1.148, 0.005, 0.1], tpm: [1.061, 0.02], stl: [0.577, 0.4], blk: [0.985, 0.1, 0.15],
      pr: [3.054, 0, 0.05], pa: [3.046, 0, 0.15], ra: [1.477, 0, 0.15], pra: [3.31, 0, 0.15],
    },
    // Overs went over less often than DraftKings' price said: this much comes off its chance of the over.
    overShift: { pts: 0.025, reb: 0.005, ast: 0.015, tpm: 0, stl: 0.04, blk: 0.015, pr: 0.03, pa: 0.02, ra: 0.01, pra: 0.035 },
    // How far the model moves the corrected market (0 = not at all). Out of sample it only held its
    // own for rebounds; for every other stat the market alone priced the lines better.
    weight: { pts: 0, reb: 0.1, ast: 0, tpm: 0, stl: 0, blk: 0, pr: 0, pa: 0, ra: 0, pra: 0 },
  };
  function params(over) {
    const P = JSON.parse(JSON.stringify(DEFAULTS));
    if (over) Object.keys(over).forEach((k) => {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) P[k] = Object.assign({}, P[k], over[k]);
      else P[k] = over[k];
    });
    return P;
  }

  /* ----------------------------------------------------------- odds maths */

  function decFromAmerican(v) {
    const s = String(v == null ? '' : v).trim().toUpperCase();
    if (s === 'EVEN' || s === 'EV') return 2;
    const a = parseFloat(s);
    if (!isFinite(a) || a === 0) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
  }
  function americanFromDec(d) {
    if (!(d > 1)) return '';
    return d >= 2 ? '+' + Math.round((d - 1) * 100) : String(-Math.round(100 / (d - 1)));
  }
  // Two-way market without the bookmaker's margin (proportional method).
  function devig(over, under) {
    if (!(over > 1) || !(under > 1)) return null;
    const a = 1 / over, b = 1 / under;
    return { over: a / (a + b), under: b / (a + b), margin: a + b - 1 };
  }
  const ev = (p, dec) => p * dec - 1;
  const kelly = (p, dec) => (dec > 1 ? (p * dec - 1) / (dec - 1) : 0);

  /* -------------------------------------------------------- distributions */

  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /* d = [a, b, c]: a negative binomial with variance a·mean + b·mean² (a Poisson when that is not
     above the mean). Real points-sized outcomes have a shorter right tail than that, so the chance of
     reaching a rung above the mean is cut by c for every standard deviation it sits above (the
     backtest fits c on DraftKings lines: without it, ladder bets such as "30+" looked better than
     they were). The cut applies to atLeast() and line(), not to the pmf drawn in the card. */
  function dist(mu, d) {
    mu = Math.max(0.01, mu);
    const phi = (d ? d[0] + d[1] * mu : 1);
    const kMax = Math.ceil(mu + 10 * Math.sqrt(Math.max(1, phi) * mu) + 12);
    const pmf = new Float64Array(kMax + 1);
    if (phi <= 1.0001) {
      pmf[0] = Math.exp(-mu);
      for (let k = 1; k <= kMax; k++) pmf[k] = pmf[k - 1] * mu / k;
    } else {
      const p = 1 / phi, r = mu * p / (1 - p);
      pmf[0] = Math.exp(r * Math.log(p));
      for (let k = 1; k <= kMax; k++) pmf[k] = pmf[k - 1] * (k - 1 + r) / k * (1 - p);
    }
    const cdf = new Float64Array(kMax + 1);
    let s = 0;
    for (let k = 0; k <= kMax; k++) { s += pmf[k]; cdf[k] = s; }
    const at = (k) => (k < 0 ? 0 : k > kMax ? 1 : cdf[k]);
    const sd = Math.sqrt(Math.max(1, phi) * mu);
    const c = d && d[2] > 0 ? d[2] : 0;
    // chance of reaching k or more, with the tail cut for rungs above the mean
    const up = (k) => {
      const p = 1 - at(k - 1);
      const z = (k - 0.5 - mu) / sd;
      return c && z > 0 ? p * Math.max(0.4, 1 - c * z) : p;
    };
    return {
      mu, phi, sd, pmf, kMax,
      cdf: at,
      atLeast: (k) => up(Math.ceil(k)),
      // a line such as 24.5 has no push; a whole number pushes when hit exactly
      line(L) {
        const f = Math.floor(L);
        if (f === L) { const over = up(L + 1), push = at(L) - at(L - 1); return { over, under: 1 - over - push, push }; }
        const over = up(f + 1);
        return { over, under: 1 - over, push: 0 };
      },
    };
  }

  function logLik(k, mu, d) {
    mu = Math.max(0.01, mu);
    const phi = d[0] + d[1] * mu;
    if (phi <= 1.0001) return k * Math.log(mu) - mu - lgamma(k + 1);
    const p = 1 / phi, r = mu * p / (1 - p);
    return lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p);
  }

  // The mean at which the chance of going over `line` equals pOver.
  function impliedMean(line, pOver, d) {
    if (!(pOver > 0 && pOver < 1)) return null;
    let lo = 0.02, hi = Math.max(5, line * 3 + 15);
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      const r = dist(mid, d).line(line);
      const p = r.over / Math.max(1e-9, r.over + r.under);
      if (p < pOver) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* ------------------------------------------------------------ game logs */

  // ET calendar day of a tip-off: games start between noon and 23:00 ET.
  const etDate = (t) => new Date(t - 6 * 3600 * 1000).toISOString().slice(0, 10);
  const prevDay = (date) => new Date(Date.parse(date + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);

  // ESPN game log (raw or as slimmed by server.py) -> regular-season games he played, oldest first.
  function normGamelog(raw) {
    if (!raw || !raw.seasonTypes) return [];
    const L = raw.labels || [];
    const ix = (n) => L.indexOf(n);
    const iMin = ix('MIN'), iFG = ix('FG'), i3 = ix('3PT'), iFT = ix('FT'), iR = ix('REB'), iA = ix('AST'),
      iB = ix('BLK'), iS = ix('STL'), iTO = ix('TO'), iP = ix('PTS');
    const pair = (v) => { const m = String(v == null ? '' : v).split('-'); return [+m[0] || 0, +m[1] || 0]; };
    const num = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
    const rows = [], seen = {};
    raw.seasonTypes.forEach((st) => {
      if (!/regular season/i.test(st.displayName || '')) return;
      (st.categories || []).forEach((c) => (c.events || []).forEach((e) => {
        const ev = raw.events && raw.events[e.eventId];
        const s = e.stats || [];
        if (!ev || seen[e.eventId]) return;
        const min = num(s[iMin]);
        if (!(min > 0)) return;
        seen[e.eventId] = 1;
        const t = Date.parse(ev.gameDate);
        const fg = pair(s[iFG]), tp = pair(s[i3]), ft = pair(s[iFT]);
        rows.push({
          id: String(e.eventId), t, date: etDate(t),
          team: String((ev.team && ev.team.id) || ''), opp: (ev.opponent && ev.opponent.abbreviation) || '', home: ev.atVs !== '@',
          min, pts: num(s[iP]), reb: num(s[iR]), ast: num(s[iA]), tpm: tp[0], tpa: tp[1], stl: num(s[iS]), blk: num(s[iB]),
          tov: num(s[iTO]), fgm: fg[0], fga: fg[1], ftm: ft[0], fta: ft[1],
        });
      }));
    });
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }

  const posGroup = (posId) => (posId === 5 ? 'C' : posId === 3 || posId === 4 ? 'F' : 'G');

  /* -------------------------------------------------------- opponent factors */

  /* players: [{ grp, rows }] for one season. Every stat of every game is compared with the player's
     average for the season; the ratios are added up by opponent and position group, and each cell is
     pulled towards 1 by `shrink` player-games. teamDates (team id -> Set of dates) marks back-to-backs. */
  function factorSums(players, opts) {
    opts = opts || {};
    const minGames = opts.minGames || 15;
    const sums = { opp: {}, home: {}, away: {}, b2b: {}, rest: {}, rate: {} };
    const add = (o, key, s, act, exp) => {
      const a = (o[s] = o[s] || {});
      const c = (a[key] = a[key] || [0, 0, 0]);
      c[0] += act; c[1] += exp; c[2] += 1;
    };
    players.forEach((pl) => {
      const rows = pl.rows || [];
      if (rows.length < minGames) return;
      const avg = {};
      BASE.forEach((s) => { avg[s] = rows.reduce((t, r) => t + r[s], 0) / rows.length; });
      const minTot = rows.reduce((t, r) => t + r.min, 0);
      BASE.forEach((s) => {
        const rr = (sums.rate[pl.grp] = sums.rate[pl.grp] || {});
        const c = (rr[s] = rr[s] || [0, 0]);
        c[0] += rows.reduce((t, r) => t + r[s], 0); c[1] += minTot;
      });
      rows.forEach((r) => {
        const b2b = opts.teamDates && opts.teamDates[r.team] ? opts.teamDates[r.team].has(prevDay(r.date)) : false;
        BASE.forEach((s) => {
          if (!(avg[s] > 0)) return;
          add(sums.opp, pl.grp + '|' + r.opp, s, r[s], avg[s]);
          add(r.home ? sums.home : sums.away, 'all', s, r[s], avg[s]);
          add(b2b ? sums.b2b : sums.rest, 'all', s, r[s], avg[s]);
        });
      });
    });
    return sums;
  }

  function buildStatFactors(players, opts) {
    opts = opts || {};
    const shrink = opts.shrink || 100;
    const sums = factorSums(players, opts);
    return factorsFromSums(sums, null, Object.assign({ shrink }, opts));
  }

  /* Factors from last season's sums, moved towards this season's (cur, optional) by curShrink
     player-games, as tools/build_factors.py does for fantasy points. */
  function factorsFromSums(last, cur, opts) {
    const shrink = opts.shrink || 100, curShrink = opts.curShrink || 50;
    const ratio = (c) => (c && c[1] > 0 ? c[0] / c[1] : 1);
    const base = (sums, s) => {
      let a = 0, e = 0;
      Object.keys(sums.opp[s] || {}).forEach((k) => { a += sums.opp[s][k][0]; e += sums.opp[s][k][1]; });
      return e > 0 ? a / e : 1;
    };
    const F = { stat: {}, posRates: {}, avgTotal: opts.avgTotal || null };
    BASE.forEach((s) => {
      const b = base(last, s), bc = cur ? base(cur, s) : 1;
      const S = (F.stat[s] = { opp: { G: {}, F: {}, C: {} } });
      Object.keys(last.opp[s] || {}).forEach((k) => {
        const [g, team] = k.split('|');
        const c = last.opp[s][k];
        let f = 1 + (ratio(c) / b - 1) * c[2] / (c[2] + shrink);
        const cc = cur && cur.opp[s] && cur.opp[s][k];
        if (cc) f += (ratio(cc) / bc - f) * cc[2] / (cc[2] + curShrink);
        S.opp[g][team] = Math.round(f * 10000) / 10000;
      });
      const rel = (o) => Math.round(ratio(o[s] && o[s].all) / b * 10000) / 10000;
      S.home = rel(last.home); S.away = rel(last.away);
      S.b2b = last.b2b[s] ? Math.round(ratio(last.b2b[s].all) / ratio(last.rest[s] && last.rest[s].all) * 10000) / 10000 : 1;
    });
    Object.keys(last.rate).forEach((g) => {
      F.posRates[g] = {};
      BASE.forEach((s) => { const c = last.rate[g][s]; F.posRates[g][s] = c && c[1] > 0 ? Math.round(c[0] / c[1] * 1e5) / 1e5 : 0; });
    });
    return F;
  }

  // Rank 1 = the defence that gives up the most of this stat to this position.
  function oppRank(F, s, grp, team) {
    const cell = F && F.stat && F.stat[s] && F.stat[s].opp && F.stat[s].opp[grp];
    if (!cell || cell[team] == null) return null;
    const teams = Object.keys(cell).sort((a, b) => cell[b] - cell[a]);
    return { rank: teams.indexOf(team) + 1, of: teams.length, factor: cell[team] };
  }

  /* ---------------------------------------------------------- projection */

  /* A running projection for one player: push his games oldest first, ask for base() at any point.
     prevRows: last season's games (the prior). posRates: his position's per-minute rates, for a
     player with no last season. */
  function projector(prevRows, P, posRates) {
    P = P || DEFAULTS;
    const prev = (prevRows || []).filter((r) => r.min > 0);
    let mPrev = null, rPrev = null, priorK = P.priorGames;
    if (prev.length >= 10) {
      const mins = prev.reduce((t, r) => t + r.min, 0);
      mPrev = mins / prev.length;
      rPrev = {};
      BASE.forEach((s) => { rPrev[s] = prev.reduce((t, r) => t + r[s], 0) / mins; });
    } else if (posRates) {
      rPrev = posRates;
      priorK = P.rookieGames;
    }
    const dR = Math.pow(0.5, 1 / P.halfLife), dM = Math.pow(0.5, 1 / P.minHalfLife);
    const w = { pts: 0, reb: 0, ast: 0, tpm: 0, stl: 0, blk: 0 };
    let wMin = 0, mNum = 0, mDen = 0, n = 0;
    return {
      push(r) {
        wMin = wMin * dR + r.min;
        for (let i = 0; i < BASE.length; i++) w[BASE[i]] = w[BASE[i]] * dR + (r[BASE[i]] || 0);
        mNum = mNum * dM + r.min; mDen = mDen * dM + 1; n++;
      },
      n: () => n,
      prior: () => ({ min: mPrev, rate: rPrev, games: prev.length }),
      base() {
        if (n < P.minGames || !(mDen > 0)) return null;
        const min = mPrev != null ? (mNum + P.priorMinGames * mPrev) / (mDen + P.priorMinGames) : mNum / mDen;
        const pm = mPrev != null ? mPrev : min;
        const rate = {};
        BASE.forEach((s) => {
          rate[s] = rPrev ? (w[s] + priorK * pm * (rPrev[s] || 0)) / (wMin + priorK * pm) : (wMin > 0 ? w[s] / wMin : 0);
        });
        return { min, rate, n };
      },
    };
  }

  function statFactor(F, s, grp, ctx, P) {
    const S = F && F.stat && F.stat[s];
    let opp = 1, venue = 1, b2b = 1, pace = 1;
    if (S) {
      const o = S.opp && S.opp[grp] && S.opp[grp][ctx.opp];
      if (o) opp = Math.pow(o, P.alpha[s] != null ? P.alpha[s] : 1);
      if (ctx.home === true && S.home) venue = S.home;
      if (ctx.home === false && S.away) venue = S.away;
      if (ctx.b2b && S.b2b) b2b = S.b2b;
    }
    if (ctx.total > 0 && F && F.avgTotal > 0) pace = Math.pow(ctx.total / F.avgTotal, P.beta[s] || 0);
    return { opp, venue, b2b, pace, all: opp * venue * b2b * pace };
  }

  // ctx: { opp, home, b2b, total, spread } for tonight's game.
  function project(base, ctx, F, P, grp) {
    P = P || DEFAULTS;
    ctx = ctx || {};
    let blow = 1;
    if (ctx.spread != null && isFinite(ctx.spread) && base.min >= P.blowMin) {
      blow = Math.max(0.8, 1 - P.gamma * Math.max(0, Math.abs(ctx.spread) - P.blowFrom));
    }
    const min = base.min * blow;
    const one = {}, factors = {};
    BASE.forEach((s) => {
      const f = statFactor(F, s, grp, ctx, P);
      factors[s] = f;
      one[s] = min * base.rate[s] * f.all;
    });
    const mu = {};
    MARKET_IDS.forEach((m) => { mu[m] = MARKETS[m].parts.reduce((t, s) => t + one[s], 0); });
    return { min, blow, mu, factors, rate: base.rate };
  }

  /* --------------------------------------------------------- book parsing */

  const normName = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, '');
  const nickname = (team) => String(team || '').trim().split(/\s+/).pop().toLowerCase();

  function bookPlayer(book, key, name) {
    const p = (book.players[key] = book.players[key] || { key, name, markets: {} });
    if (name && !p.name) p.name = name;
    return p;
  }
  const marketOf = (p, m) => (p.markets[m] = p.markets[m] || { lines: [], ladder: [] });

  const ESPN_TOTAL = { 1: 'pts', 2: 'ast', 3: 'reb', 4: 'tpm', 5: 'stl', 6: 'blk', 87: 'pa', 88: 'pr', 89: 'ra', 90: 'pra' };
  const ESPN_MILE = { 218: 'pts', 219: 'ast', 220: 'reb', 221: 'tpm', 222: 'stl', 223: 'blk', 225: 'pra', 226: 'pa', 227: 'pr', 327: 'ra' };

  /* DraftKings lines from ESPN's propBets (raw or slimmed). Each over/under comes as two items with no
     side named; the over comes first. A milestone at line + 0.5 ("25+") is the same bet as the over,
     so it confirms the order and swaps a pair that disagrees. Keyed by ESPN athlete id. */
  function parseEspnProps(data) {
    const book = { book: 'DraftKings', players: {} };
    const pending = {};
    const athlete = (it) => { const m = /athletes\/(\d+)/.exec((it.athlete && it.athlete.$ref) || ''); return m ? m[1] : null; };
    const target = (o) => (o && o.target && isFinite(o.target.value) ? +o.target.value : null);
    ((data && data.items) || []).forEach((it) => {
      const id = athlete(it);
      const tid = +(it.type && it.type.id);
      const am = (it.odds && it.odds.american) || {};
      if (!id) return;
      if (ESPN_TOTAL[tid]) {
        const m = ESPN_TOTAL[tid], line = target(it.current);
        if (line == null) return;
        const key = id + '|' + m + '|' + line;
        if (!pending[key]) { pending[key] = it; return; }
        const a = pending[key];
        delete pending[key];
        const aa = (a.odds && a.odds.american) || {};
        marketOf(bookPlayer(book, id), m).lines.push({
          line, over: decFromAmerican(aa.value), under: decFromAmerican(am.value),
          open: { line: target(a.open), over: decFromAmerican(aa.open), under: decFromAmerican(am.open) },
        });
      } else if (ESPN_MILE[tid]) {
        const k = target(it.current), d = decFromAmerican(am.value);
        if (k == null || !d) return;
        // Ladders for other periods (a quarter) come under the same type: a rung that does not go up
        // starts a new ladder, and the one that agrees with the main line is kept below.
        const mk = marketOf(bookPlayer(book, id), ESPN_MILE[tid]);
        mk.runs = mk.runs || [];
        const run = mk.runs[mk.runs.length - 1];
        if (!run || k <= run[run.length - 1].k) mk.runs.push([{ k, dec: d }]);
        else run.push({ k, dec: d });
      }
    });
    Object.keys(book.players).forEach((id) => {
      const P = book.players[id];
      Object.keys(P.markets).forEach((m) => {
        const mk = P.markets[m];
        const runs = mk.runs || [];
        delete mk.runs;
        if (runs.length === 1) mk.ladder = runs[0];
        else if (runs.length > 1) {
          const L = mainLine(mk);
          const f = L && devig(L.over, L.under);
          const score = (run) => {
            if (!f) return -run.length;
            const r = run.find((x) => x.k === Math.floor(L.line) + 1);
            return r ? Math.abs(1 / r.dec - f.over) : 9;
          };
          mk.ladder = runs.slice().sort((a, b) => score(a) - score(b))[0];
          if (f && score(mk.ladder) > 0.2) mk.ladder = []; // none agrees with the line: trust none
        }
        mk.lines.forEach((L) => {
          const mile = mk.ladder.find((x) => x.k === L.line + 0.5);
          if (!mile || !L.over || !L.under) return;
          const q = 1 / mile.dec;
          if (Math.abs(q - 1 / L.under) + 0.03 < Math.abs(q - 1 / L.over)) {
            const t = L.over; L.over = L.under; L.under = t;
            const o = L.open; const u = o.over; o.over = o.under; o.under = u;
          }
        });
      });
    });
    return book;
  }

  // Betano: the "Jogadores" tab of a game (api/odds/<game>/?bt=1). Keyed by normalised name.
  const BETANO_TWO = { X025: 'pts', X028: 'ast', X027: 'reb', X054: 'tpm', X030: 'stl', X029: 'blk', X040: 'pra', X038: 'ra', X037: 'pr', X039: 'pa' };
  const BETANO_LADDER = { PLNP: 'pts', PALA: 'ast', PLTR: 'reb', P3PG: 'tpm', PLNS: 'stl', PALB: 'blk', BPRA: 'pra', BBRA: 'ra' };
  function parseBetanoEvent(json) {
    const ev = json && json.data && json.data.event;
    if (!ev) return null;
    const book = { book: 'Betano', id: String(ev.id), name: ev.name, start: ev.startTime, url: ev.url, players: {} };
    (ev.markets || []).forEach((mk) => {
      const two = BETANO_TWO[mk.type], lad = BETANO_LADDER[mk.type];
      if (!two && !lad) return;
      ((mk.tableLayout && mk.tableLayout.rows) || []).forEach((r) => {
        if (!r.title) return;
        const p = bookPlayer(book, normName(r.title), r.title);
        (r.groupSelections || []).forEach((g) => {
          const sel = g.selections || [];
          if (two) {
            const o = sel.find((s) => /^mais/i.test(s.name || '')) || sel.find((s) => s.columnIndex === 0);
            const u = sel.find((s) => /^menos/i.test(s.name || '')) || sel.find((s) => s.columnIndex === 1);
            const line = +(g.handicap || (o && o.handicap) || 0);
            if (o && u && line > 0 && o.price > 1 && u.price > 1) marketOf(p, two).lines.push({ line, over: +o.price, under: +u.price });
          } else {
            sel.forEach((s) => {
              const k = parseInt(s.name, 10);
              if (k > 0 && s.price > 1) marketOf(p, lad).ladder.push({ k, dec: +s.price });
            });
          }
        });
      });
    });
    return book;
  }
  function parseBetanoLeague(json) {
    const out = [];
    const blocks = (json && json.data && json.data.blocks) || [];
    blocks.forEach((b) => (b.events || []).forEach((e) => {
      if (e && e.url && e.name) out.push({ id: String(e.id), name: e.name, start: e.startTime, url: e.url });
    }));
    return out;
  }

  // Betclic: no public API; the server hands over the gRPC answers embedded in the page (ng-state).
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function betclicPayloads(state) {
    const out = [];
    Object.keys(state || {}).forEach((k) => {
      const r = state[k] && state[k].response;
      if (r && r.payload) out.push(r.payload);
    });
    return out;
  }
  function parseBetclicLeague(state) {
    const out = [];
    betclicPayloads(state).forEach((p) => (p.matches || []).forEach((m) => {
      if (!m.matchId || !m.name || m.isLive) return;
      out.push({ id: String(m.matchId), name: m.name, start: Date.parse(m.matchDateUtc), path: '/basquetebol-sbasketball/nba-c13/' + slug(m.name) + '-m' + m.matchId });
    }));
    return out;
  }
  function betclicStat(name) {
    const n = String(name || '').toLowerCase();
    const p = /pontos/.test(n), r = /ressalto/.test(n), a = /assist/.test(n);
    if (p && r && a) return 'pra';
    if (/triplo|3 pontos/.test(n)) return 'tpm';
    if (p && r) return 'pr';
    if (p && a) return 'pa';
    if (r && a) return 'ra';
    if (p) return 'pts';
    if (r) return 'reb';
    if (a) return 'ast';
    return null;
  }
  const commaNum = (s) => parseFloat(String(s).replace(',', '.'));
  function parseBetclicEvent(state) {
    let match = null;
    betclicPayloads(state).forEach((p) => { if (p.match) match = p.match; });
    if (!match) return null;
    const book = { book: 'Betclic', id: String(match.matchId), name: match.name, start: Date.parse(match.matchDateUtc), players: {} };
    const markets = [];
    (match.subCategories || []).forEach((c) => (c.markets || []).forEach((m) => markets.push(m)));
    (match.markets || []).forEach((m) => markets.push(m));
    const seen = {};
    markets.forEach((mk) => {
      if (!mk || seen[mk.id]) return;
      seen[mk.id] = 1;
      const stat = betclicStat(mk.name);
      if (!stat) return;
      const isPlayer = /jogador/i.test(mk.name || '');
      // over/under rows: "<Player> Acima de 10,5" / "<Player> Abaixo de 10,5"
      if (isPlayer) {
        (mk.selectionMatrix || []).forEach((row) => {
          const sel = (row.selections || []).map((s) => s.selectionOneof && s.selectionOneof.selection).filter(Boolean);
          let name = null, line = null, over = null, under = null;
          sel.forEach((s) => {
            const m = /^(.+?)\s+(Acima|Abaixo) de\s+(\d+(?:,\d+)?)$/i.exec(s.name || '');
            if (!m) return;
            name = m[1]; line = commaNum(m[3]);
            if (/acima/i.test(m[2])) over = +s.odds; else under = +s.odds;
          });
          if (name && line > 0 && over > 1 && under > 1) marketOf(bookPlayer(book, normName(name), name), stat).lines.push({ line, over, under });
        });
      }
      // ladders: a named player with slider values "over 19.5" -> "20+"
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 8) return;
        if (Array.isArray(o.sliderValues) && o.name) {
          const p = bookPlayer(book, normName(o.name), o.name);
          o.sliderValues.forEach((v) => {
            const s = v.selections && v.selections[0] && v.selections[0].selectionOneof && v.selections[0].selectionOneof.selection;
            if (s && s.odds > 1 && isFinite(v.value)) marketOf(p, stat).ladder.push({ k: Math.floor(v.value) + 1, dec: +s.odds });
          });
          return;
        }
        Object.keys(o).forEach((k) => walk(o[k], depth + 1));
      };
      walk(mk, 0);
    });
    return book;
  }

  /* ESPN scoreboard -> games: { id, date, start, home: {id, ab, name}, away: {...}, total, spread (home's), state }. */
  function parseScoreboard(json) {
    return ((json && json.events) || []).map((e) => {
      const c = (e.competitions && e.competitions[0]) || {};
      const team = (side) => {
        const t = (c.competitors || []).find((x) => x.homeAway === side) || {};
        return { id: String((t.team && t.team.id) || ''), ab: (t.team && t.team.abbreviation) || '', name: (t.team && t.team.displayName) || '', score: t.score != null ? +t.score : null };
      };
      const o = (c.odds && c.odds[0]) || {};
      const t = Date.parse(e.date);
      return {
        id: String(e.id), start: t, date: etDate(t), home: team('home'), away: team('away'),
        total: isFinite(o.overUnder) ? +o.overUnder : null, spread: isFinite(o.spread) ? +o.spread : null,
        oddsBy: (o.provider && o.provider.name) || null,
        state: (e.status && e.status.type && e.status.type.state) || 'pre',
      };
    });
  }

  // Find the book's game for an ESPN game by the two team nicknames ("Raptors", "Knicks").
  function matchGame(game, list) {
    const want = [nickname(game.home.name), nickname(game.away.name)].sort().join('|');
    return (list || []).find((g) => {
      const parts = String(g.name || '').split(/\s+[-–@]\s+|\s+vs\.?\s+/i);
      if (parts.length !== 2) return false;
      return parts.map(nickname).sort().join('|') === want;
    }) || null;
  }

  // Book players (keyed by name) -> ESPN athlete ids, for the players in one game.
  function matchPlayers(book, roster) {
    const byName = {}, byLast = {};
    roster.forEach((r) => {
      byName[normName(r.name)] = r.id;
      const parts = String(r.name).split(/\s+/);
      const k = normName(parts[parts.length - 1]) + '|' + normName(parts[0]).charAt(0);
      byLast[k] = byLast[k] === undefined ? r.id : null; // ambiguous -> null
    });
    const out = {};
    Object.keys(book.players).forEach((key) => {
      const p = book.players[key];
      let id = byName[key];
      if (id == null && p.name) {
        const parts = String(p.name).split(/\s+/);
        id = byLast[normName(parts[parts.length - 1]) + '|' + normName(parts[0]).charAt(0)];
      }
      if (id != null) out[id] = p;
    });
    return out;
  }

  // ESPN's public injury report -> [{ id, name, teamId, status, note, returnDate }].
  function parseInjuryList(raw) {
    const out = [];
    ((raw && raw.injuries) || []).forEach((t) => ((t && t.injuries) || []).forEach((i) => {
      const a = (i && i.athlete) || {};
      const href = (a.links || []).map((l) => (l && l.href) || '').find((h) => /\/id\/\d+/.test(h));
      if (!href) return;
      const d = i.details || {};
      out.push({
        id: +/\/id\/(\d+)/.exec(href)[1], name: a.displayName || '', teamId: String(t.id || ''), status: i.status || '',
        note: i.shortComment || '', returnDate: /^\d{4}-\d{2}-\d{2}/.test(d.returnDate || '') ? d.returnDate.slice(0, 10) : null,
      });
    }));
    return out;
  }

  /* ------------------------------------------------------------ analysis */

  const mean = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);

  function hitRate(rows, m, line) {
    const xs = rows.map((r) => statOf(r, m));
    const over = xs.filter((x) => x > line).length, under = xs.filter((x) => x < line).length;
    return { n: xs.length, over, under, avg: mean(xs) };
  }

  /* Everything the deep-dive card shows for one player and stat. rows: this season before tonight;
     prevRows: last season; line: the main line; mates: [{ name, rows }] teammates out tonight. */
  function analysis(o) {
    const { rows, prevRows, m, line, ctx, F, grp } = o;
    const last = (n) => rows.slice(-n);
    const vsOpp = rows.concat(prevRows || []).filter((r) => r.opp === ctx.opp);
    const out = {
      last5: hitRate(last(5), m, line), last10: hitRate(last(10), m, line), season: hitRate(rows, m, line),
      lastSeason: hitRate(prevRows || [], m, line), vsOpp: hitRate(vsOpp, m, line),
      games: last(10).map((r) => ({ date: r.date, opp: r.opp, home: r.home, v: statOf(r, m), min: r.min })),
      min5: mean(last(5).map((r) => r.min)), minSeason: mean(rows.map((r) => r.min)),
      fga5: mean(last(5).map((r) => r.fga)), fgaSeason: mean(rows.map((r) => r.fga)),
      ranks: {},
      without: [],
    };
    MARKETS[m].parts.forEach((s) => { out.ranks[s] = oppRank(F, s, grp, ctx.opp); });
    (o.mates || []).forEach((mate) => {
      const played = new Set((mate.rows || []).map((r) => r.date));
      const team = rows.length ? rows[rows.length - 1].team : null;
      const without = rows.filter((r) => r.team === team && !played.has(r.date));
      const withM = rows.filter((r) => r.team === team && played.has(r.date));
      if (without.length >= 2 && withM.length >= 2) {
        out.without.push({
          name: mate.name, n: without.length, nWith: withM.length,
          avg: mean(without.map((r) => statOf(r, m))), avgWith: mean(withM.map((r) => statOf(r, m))),
          min: mean(without.map((r) => r.min)), minWith: mean(withM.map((r) => r.min)),
        });
      }
    });
    return out;
  }

  /* ------------------------------------------------------------- pricing */

  /* A price this far below our chance is almost always a different bet read as this one (another
     period, a misnamed player), not value: such bets are shown but never ranked. */
  const SUSPECT = 0.2;
  /* The backtest checked rungs and alternative lines up to about one standard deviation from the
     market's mean; further out they are shown but not ranked. */
  const TESTED_SD = 1.25;

  // The line a book treats as its main one: the over/under closest to even money.
  function mainLine(mk) {
    if (!mk || !mk.lines.length) return null;
    return mk.lines.slice().sort((a, b) => Math.abs(1 / a.over - 1 / a.under) - Math.abs(1 / b.over - 1 / b.under))[0];
  }

  /* Price one player's stat. books: [{ book, mk }] with mk = { lines, ladder } (DraftKings first: its
     margin is smallest, so its line anchors the market). Returns the means, the distribution and a
     row for every bet on offer. */
  function price(o) {
    const P = o.P || DEFAULTS;
    const m = o.m, d = P.disp[m], muModel = o.muModel;
    let anchor = null;
    for (let i = 0; i < o.books.length && !anchor; i++) {
      const L = mainLine(o.books[i].mk);
      const f = L && devig(L.over, L.under);
      if (f) {
        const sh = P.overShift && typeof P.overShift === 'object' ? P.overShift[m] || 0 : P.overShift || 0;
        const pOver = Math.min(0.98, Math.max(0.02, f.over - sh));
        anchor = { book: o.books[i].book, line: L.line, pOverRaw: f.over, pOver, margin: f.margin, mu: impliedMean(L.line, pOver, d), L };
      }
    }
    const w = P.weight[m] || 0;
    const muMkt = anchor ? anchor.mu : null;
    const mu = muMkt != null && muModel != null ? muMkt + w * (muModel - muMkt) : muModel != null ? muModel : muMkt;
    if (mu == null) return null;
    const D = dist(mu, d);
    const far = (k) => Math.abs(k - 0.5 - mu) / D.sd > TESTED_SD;
    const bets = [];
    o.books.forEach((b) => {
      b.mk.lines.forEach((L) => {
        const r = D.line(L.line);
        const fair = devig(L.over, L.under);
        [['over', L.over, r.over], ['under', L.under, r.under]].forEach(([side, dec, p]) => {
          if (!(dec > 1)) return;
          const pw = p + r.push / 2; // a push returns the stake: count it as half a win for the price
          bets.push({ book: b.book, side, line: L.line, dec, p: pw, ev: ev(p, dec) + r.push, kelly: kelly(pw, dec), margin: fair ? fair.margin : null, open: L.open || null, suspect: pw - 1 / dec > SUSPECT, far: far(Math.floor(L.line) + 1) });
        });
      });
      b.mk.ladder.forEach((x) => {
        const p = D.atLeast(x.k);
        bets.push({ book: b.book, side: 'atleast', line: x.k, dec: x.dec, p, ev: ev(p, x.dec), kelly: kelly(p, x.dec), margin: null, suspect: p - 1 / x.dec > SUSPECT, far: far(x.k) });
      });
    });
    return { m, mu, muModel, muMkt, w, anchor, dist: D, bets };
  }

  /* One night's board from WPOdds.loadNight: every player DraftKings prices, every stat, every bet
     on offer at DraftKings, Betano and Betclic, priced against the corrected DraftKings line.
     lines: one per player and stat; picks: one per bet (its `entry` is the line), best value first. */
  function buildBoard(night, F, P) {
    P = P || DEFAULTS;
    const lines = [];
    (night.games || []).forEach((g) => {
      const dk = g.books && g.books.DraftKings;
      if (!dk) return;
      const ids = Object.keys(dk.players);
      const roster = ids.map((id) => ({ id, name: (night.players[id] || {}).name || '' })).filter((r) => r.name);
      const bn = g.books.Betano ? matchPlayers(g.books.Betano, roster) : {};
      const bc = g.books.Betclic ? matchPlayers(g.books.Betclic, roster) : {};
      ids.forEach((id) => {
        const pl = night.players[id];
        if (!pl) return;
        const before = pl.rows.filter((r) => r.date < night.date);
        const team = before.length ? before[before.length - 1].team : String(pl.proTeamId || '');
        const home = team === g.home.id ? true : team === g.away.id ? false : null;
        if (home == null) return; // traded away, or not on either team: leave him out
        const ctx = {
          opp: home ? g.away.ab : g.home.ab, team: home ? g.home.ab : g.away.ab, home,
          b2b: !!(g.b2b && (home ? g.b2b.home : g.b2b.away)), total: g.total,
          spread: g.spread == null ? null : home ? g.spread : -g.spread,
        };
        const pj = projector(pl.prev, P, F && F.posRates ? F.posRates[pl.grp] : null);
        before.forEach((r) => pj.push(r));
        const base = pj.base();
        const proj = base ? project(base, ctx, F, P, pl.grp) : null;
        const mates = (night.out || []).filter((o) => String(o.teamId) === team && String(o.id) !== id)
          .map((o) => ({ name: o.name, rows: (night.players[String(o.id)] && night.players[String(o.id)].rows) || [] }));
        Object.keys(dk.players[id].markets).forEach((m) => {
          if (!MARKETS[m]) return;
          const books = [{ book: 'DraftKings', mk: dk.players[id].markets[m] }];
          if (bn[id] && bn[id].markets[m]) books.push({ book: 'Betano', mk: bn[id].markets[m] });
          if (bc[id] && bc[id].markets[m]) books.push({ book: 'Betclic', mk: bc[id].markets[m] });
          const pr = price({ m, books, muModel: proj ? proj.mu[m] : null, P });
          if (!pr || !pr.anchor) return;
          lines.push({ key: id + '|' + m, id, name: pl.name, grp: pl.grp, injury: pl.injury, game: g, m, ctx, proj, pr, mates, rows: before, prev: pl.prev || [] });
        });
      });
    });
    const picks = [];
    lines.forEach((L) => L.pr.bets.forEach((b) => !b.suspect && !b.far && picks.push(Object.assign({ entry: L, key: L.key + '|' + b.book + '|' + b.side + '|' + b.line }, b))));
    picks.sort((a, b) => b.ev - a.ev);
    return { lines, picks };
  }

  const pct = (x) => (x == null ? '' : (x > 0 ? '+' : '') + Math.round(x * 100) + '%');

  // Plain-language reasons, strongest first, for the card's "Why" list.
  function reasons(o) {
    const { a, proj, m, side, line, ctx, grp, pr } = o;
    const out = [];
    const up = side !== 'under';
    if (pr.muMkt != null && pr.muModel != null) {
      const diff = pr.muModel - pr.muMkt;
      out.push({ w: Math.abs(diff) / Math.max(1, pr.muMkt), good: (diff > 0) === up, t: 'Our projection ' + pr.muModel.toFixed(1) + ' against the market’s ' + pr.muMkt.toFixed(1) + '.' });
    }
    MARKETS[m].parts.forEach((s) => {
      const r = a.ranks[s];
      if (!r) return;
      const f = proj.factors[s].opp;
      const lbl = MARKETS[s].label.toLowerCase();
      if (r.rank <= 6) out.push({ w: Math.abs(f - 1) * 2, good: up, t: ctx.opp + ' gives up the ' + ordinal(r.rank) + '-most ' + lbl + ' to ' + GROUP_NAME[grp] + ' (' + pct(r.factor - 1) + ').' });
      else if (r.rank > r.of - 6) out.push({ w: Math.abs(f - 1) * 2, good: !up, t: ctx.opp + ' gives up the ' + ordinal(r.of - r.rank + 1) + '-fewest ' + lbl + ' to ' + GROUP_NAME[grp] + ' (' + pct(r.factor - 1) + ').' });
    });
    if (a.min5 != null && a.minSeason) {
      const ch = a.min5 / a.minSeason - 1;
      if (Math.abs(ch) >= 0.08) out.push({ w: Math.abs(ch), good: (ch > 0) === up, t: 'Minutes ' + (ch > 0 ? 'up' : 'down') + ': ' + a.min5.toFixed(1) + ' over the last 5 against ' + a.minSeason.toFixed(1) + ' this season.' });
    }
    const L10 = a.last10;
    if (L10.n >= 6) {
      const hit = up ? L10.over : L10.under;
      if (hit / L10.n >= 0.7) out.push({ w: 0.05, good: true, t: (up ? 'Over' : 'Under') + ' ' + line + ' in ' + hit + ' of his last ' + L10.n + '.' });
      else if (hit / L10.n <= 0.3) out.push({ w: 0.05, good: false, t: (up ? 'Over' : 'Under') + ' ' + line + ' in only ' + hit + ' of his last ' + L10.n + '.' });
    }
    if (proj.blow < 0.99) out.push({ w: 1 - proj.blow, good: !up, t: 'A ' + Math.abs(ctx.spread) + '-point spread: starters may sit late (' + Math.round((1 - proj.blow) * 100) + '% fewer minutes).' });
    if (ctx.total && proj.factors.pts && Math.abs(proj.factors.pts.pace - 1) >= 0.015) {
      const f = proj.factors.pts.pace;
      out.push({ w: Math.abs(f - 1), good: (f > 1) === up, t: 'Game total ' + ctx.total + (f > 1 ? ', above' : ', below') + ' the usual pace.' });
    }
    if (ctx.b2b) out.push({ w: 0.02, good: !up, t: 'Second night of a back-to-back.' });
    a.without.forEach((x) => {
      const ch = x.avg - x.avgWith;
      if (Math.abs(ch) >= 1) out.push({ w: Math.abs(ch) / Math.max(1, x.avgWith) / 2, good: (ch > 0) === up, t: 'Without ' + x.name + ' (' + x.n + ' games): ' + x.avg.toFixed(1) + ' against ' + x.avgWith.toFixed(1) + ' with him.' });
    });
    return out.sort((x, y) => y.w - x.w);
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  return {
    BASE, MARKETS, MARKET_IDS, DEFAULTS, GROUP_NAME, params, statOf,
    decFromAmerican, americanFromDec, devig, ev, kelly,
    lgamma, dist, logLik, impliedMean,
    etDate, prevDay, normGamelog, posGroup,
    factorSums, buildStatFactors, factorsFromSums, oppRank,
    projector, statFactor, project,
    normName, nickname, parseEspnProps, parseBetanoEvent, parseBetanoLeague, parseBetclicLeague, parseBetclicEvent,
    parseScoreboard, matchGame, matchPlayers, slug, parseInjuryList,
    hitRate, analysis, mainLine, price, buildBoard, reasons, ordinal,
  };
});
