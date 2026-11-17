#!/usr/bin/env node
/* Backtest for the Bets view, through web/bets.js itself.

   Part 1, fit (2025-26) and check (2024-25): every game of the most rostered players, projected with
   only the games before it and last season as the prior. It picks the recency weights, the prior's
   weight, the strength of the opponent, game-total and blowout adjustments, and the spread of each
   stat, then checks them on the other season.

   Part 2, against the market (2026-27 so far): DraftKings' closing player lines, which ESPN keeps for
   this season. It measures how far the model should move the market's line, out of sample, and what
   betting on it would have returned, next to two popular rules of thumb: Linemaker's (bet the over
   against the defences that give up the most of a stat, the under against the stingiest) and the
   hit-rate rule (over when he went over the line in 7 of his last 10).

     node tools/backtest_props.js              both parts (first run reads a few thousand ESPN pages)
     node tools/backtest_props.js --market     part 2 only, with the parameters in web/bets.js
*/
'use strict';
const D = require('./props_data.js');
const B = require('../web/bets.js');

const log = (s) => process.stderr.write(s + '\n');
const out = (s) => process.stdout.write(s + '\n');
const args = process.argv.slice(2);
const MARKET_ONLY = args.includes('--market');
const f1 = (x) => (x == null || !isFinite(x) ? '-' : x.toFixed(1));
const f2 = (x) => (x == null || !isFinite(x) ? '-' : x.toFixed(2));
const f3 = (x) => (x == null || !isFinite(x) ? '-' : x.toFixed(3));
const pc = (x) => (x == null || !isFinite(x) ? '-' : (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%');

/* --------------------------------------------------------------- data */

async function loadSeason(season) {
  const games = await D.seasonGames(season, log);
  const idx = D.indexGames(games);
  const ids = D.cachedIds(season);
  const pos = await D.positions(season, ids);
  const players = [];
  await D.pool(ids, 8, async (id) => {
    if (!pos[id]) return;
    const rows = await D.playerRows(season, id, idx.byId);
    if (rows.length) players.push({ id, grp: B.posGroup(pos[id].pos), rows });
  });
  const totals = games.map((g) => g.total).filter((x) => x > 150);
  return { season, games, byId: idx.byId, teamDates: idx.teamDates, players, avgTotal: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null };
}

// Last season's games by player id, for the prior (players not in the cache get none).
async function priorRows(season, ids) {
  const out = {};
  const have = new Set(D.cachedIds(season));
  await D.pool(ids.filter((id) => have.has(id)), 8, async (id) => { out[id] = await D.playerRows(season, id, null); });
  return out;
}

function factorsFor(set, avgTotal) {
  return B.buildStatFactors(set.players, { teamDates: set.teamDates, avgTotal: avgTotal || set.avgTotal });
}

function ctxOf(set, r) {
  const g = set.byId && set.byId[r.id];
  const td = set.teamDates && set.teamDates[r.team];
  return { opp: r.opp, home: r.home, b2b: !!(td && td.has(B.prevDay(r.date))), total: g ? g.total : null, spread: g ? g.spread : null };
}

/* ----------------------------------------------------------- part 1: fit */

// Squared error of min × rate for every stat, and of the season-to-date average (the naive guess).
function baseScore(set, prior, F, P) {
  const sse = {}, naive = {};
  B.BASE.forEach((s) => { sse[s] = 0; naive[s] = 0; });
  let n = 0;
  set.players.forEach((pl) => {
    const proj = B.projector(prior[pl.id], P, F.posRates[pl.grp]);
    const tot = { pts: 0, reb: 0, ast: 0, tpm: 0, stl: 0, blk: 0 };
    pl.rows.forEach((r, i) => {
      const b = proj.base();
      if (b) {
        n++;
        B.BASE.forEach((s) => {
          const e = b.min * b.rate[s] - r[s];
          sse[s] += e * e;
          const nv = tot[s] / i - r[s];
          naive[s] += nv * nv;
        });
      }
      proj.push(r);
      B.BASE.forEach((s) => { tot[s] += r[s]; });
    });
  });
  let score = 0;
  B.BASE.forEach((s) => { score += sse[s] / naive[s]; });
  return { score: score / B.BASE.length, sse, naive, n };
}

function records(set, prior, F, P) {
  const recs = [];
  set.players.forEach((pl) => {
    const proj = B.projector(prior[pl.id], P, F.posRates[pl.grp]);
    const tot = { pts: 0, reb: 0, ast: 0, tpm: 0, stl: 0, blk: 0 };
    pl.rows.forEach((r, i) => {
      const b = proj.base();
      if (b) {
        const nv = {};
        B.BASE.forEach((s) => { nv[s] = tot[s] / i; });
        recs.push({ grp: pl.grp, b, r, ctx: ctxOf(set, r), naive: nv });
      }
      proj.push(r);
      B.BASE.forEach((s) => { tot[s] += r[s]; });
    });
  });
  return recs;
}

function muAll(rec, F, P) {
  return B.project(rec.b, rec.ctx, F, P, rec.grp).mu;
}

function fitContext(recs, F, P, naiveSse) {
  // blowout first, with every stat counted
  let best = null;
  [0, 0.005, 0.01, 0.015, 0.02, 0.03].forEach((gamma) => [4, 6, 8, 10].forEach((blowFrom) => {
    const Q = B.params(Object.assign({}, P, { gamma, blowFrom }));
    const sse = {};
    B.BASE.forEach((s) => { sse[s] = 0; });
    recs.forEach((rec) => { const mu = muAll(rec, F, Q); B.BASE.forEach((s) => { const e = mu[s] - rec.r[s]; sse[s] += e * e; }); });
    const score = B.BASE.reduce((t, s) => t + sse[s] / naiveSse[s], 0);
    if (!best || score < best.score) best = { score, gamma, blowFrom };
  }));
  P = B.params(Object.assign({}, P, { gamma: best.gamma, blowFrom: best.blowFrom }));
  // then the opponent and game-total strength, stat by stat
  const alpha = {}, beta = {};
  B.BASE.forEach((s) => {
    let bs = null;
    [0, 0.5, 1, 1.5, 2].forEach((a) => [0, 0.25, 0.5, 0.75, 1, 1.5].forEach((bb) => {
      const Q = B.params(Object.assign({}, P, { alpha: { [s]: a }, beta: { [s]: bb } }));
      let sse = 0;
      recs.forEach((rec) => {
        const proj = B.project(rec.b, rec.ctx, F, Q, rec.grp);
        const e = proj.mu[s] - rec.r[s];
        sse += e * e;
      });
      if (!bs || sse < bs.sse) bs = { sse, a, bb };
    }));
    alpha[s] = bs.a; beta[s] = bs.bb;
  });
  return B.params(Object.assign({}, P, { alpha, beta }));
}

// variance = a·mean + b·mean²: moments first, then the likelihood around them.
function fitDispersion(recs, F, P) {
  const disp = {};
  const sample = recs.filter((_, i) => i % 2 === 0);
  const mus = sample.map((rec) => muAll(rec, F, P));
  B.MARKET_IDS.forEach((m) => {
    let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
    sample.forEach((rec, i) => {
      const mu = mus[i][m], k = B.statOf(rec.r, m), y = (k - mu) * (k - mu);
      s11 += mu * mu; s12 += mu * mu * mu; s22 += mu * mu * mu * mu; t1 += y * mu; t2 += y * mu * mu;
    });
    const det = s11 * s22 - s12 * s12;
    let a = det ? (t1 * s22 - t2 * s12) / det : 1.2;
    let b = det ? (s11 * t2 - s12 * t1) / det : 0.03;
    a = Math.max(1, a); b = Math.max(0, b);
    let best = null;
    [-0.3, -0.15, 0, 0.15, 0.3].forEach((da) => [0.6, 0.8, 1, 1.25, 1.5].forEach((fb) => {
      const d = [Math.max(1, a + da), b * fb];
      let ll = 0;
      sample.forEach((rec, i) => { ll += B.logLik(B.statOf(rec.r, m), mus[i][m], d); });
      if (!best || ll > best.ll) best = { ll, d };
    }));
    disp[m] = best.d.map((x) => Math.round(x * 1000) / 1000);
  });
  return B.params(Object.assign({}, P, { disp }));
}

function report(label, recs, F, P) {
  out('\n' + label + ' (' + recs.length + ' player-games)');
  out('Stat      | off per game (model) | (season average so far) | better');
  const mus = recs.map((rec) => muAll(rec, F, P));
  B.MARKET_IDS.forEach((m) => {
    let se = 0, sn = 0, bm = 0, bn = 0, n = 0;
    recs.forEach((rec, i) => {
      const k = B.statOf(rec.r, m), mu = mus[i][m];
      const nv = B.MARKETS[m].parts.reduce((t, s) => t + rec.naive[s], 0);
      se += Math.abs(mu - k); sn += Math.abs(nv - k);
      // a line at the naive average: chance of going over, scored with the Brier score
      const line = Math.floor(nv) + 0.5;
      const pm = B.dist(mu, P.disp[m]).line(line).over, pn = B.dist(nv, P.disp[m]).line(line).over;
      const y = k > line ? 1 : 0;
      bm += (pm - y) * (pm - y); bn += (pn - y) * (pn - y); n++;
    });
    out((m + '        ').slice(0, 10) + '| ' + f2(se / n) + '                 | ' + f2(sn / n) + '                    | ' +
      pc(1 - se / sn) + '  (Brier ' + f3(bm / n) + ' v ' + f3(bn / n) + ')');
  });
}

/* --------------------------------------------------- part 2: the market */

async function marketRecords(set26, F, P) {
  const games = await D.seasonGames(2027, log);
  const idx = D.indexGames(games);
  log('  reading DraftKings closing lines for ' + games.length + ' games...');
  const props = await D.pool(games, 8, (g) => D.gameProps(g.id));
  const books = games.map((g, i) => ({ g, book: props[i] ? B.parseEspnProps(props[i]) : null })).filter((x) => x.book && Object.keys(x.book.players).length);
  const ids = [...new Set([].concat(...books.map((x) => Object.keys(x.book.players))))];
  log('  ' + books.length + ' games with lines, ' + ids.length + ' players; reading game logs...');
  const pos = await D.positions(2027, ids);
  const rows27 = {}, rows26 = {};
  await D.pool(ids, 8, async (id) => {
    rows27[id] = await D.playerRows(2027, id, null);
    rows26[id] = await D.playerRows(2026, id, set26.byId);
  });
  const recs = [];
  books.forEach(({ g, book }) => {
    Object.keys(book.players).forEach((id) => {
      const p = pos[id];
      const rows = rows27[id] || [];
      const act = rows.find((r) => r.id === g.id);
      if (!p || !act) return; // did not play: DraftKings voids the bet
      const grp = B.posGroup(p.pos);
      const proj = B.projector(rows26[id], P, F.posRates[grp]);
      const before = rows.filter((r) => r.date < g.date);
      before.forEach((r) => proj.push(r));
      const base = proj.base();
      if (!base) return;
      const td = idx.teamDates[act.team];
      const ctx = { opp: act.opp, home: act.home, b2b: !!(td && td.has(B.prevDay(g.date))), total: g.total, spread: g.spread };
      const pr = B.project(base, ctx, F, P, grp);
      const last10 = before.slice(-10);
      Object.keys(book.players[id].markets).forEach((m) => {
        const L = B.mainLine(book.players[id].markets[m]);
        const fair = L && B.devig(L.over, L.under);
        if (!fair || !(L.line > 0)) return;
        const k = B.statOf(act, m);
        if (k === L.line) return; // push
        const rank = B.MARKETS[m].parts.length === 1 ? B.oppRank(F, m, grp, ctx.opp) : null;
        recs.push({
          m, date: g.date, day: +g.date.slice(8, 10), line: L.line, over: L.over, under: L.under, pFair: fair.over, margin: fair.margin,
          muModel: pr.mu[m], muMkt: B.impliedMean(L.line, fair.over, P.disp[m]), y: k > L.line ? 1 : 0, act: k,
          rank, hit10: last10.length === 10 ? last10.filter((r) => B.statOf(r, m) > L.line).length : null,
        });
      });
    });
  });
  return recs;
}

const LADDER_STEPS = { pts: [-6, -3, 3, 6], reb: [-3, -2, 2, 3], ast: [-3, -2, 2, 3], tpm: [-1, 1, 2], stl: [1, 2], blk: [1, 2], pra: [-8, -4, 4, 8], pr: [-6, -3, 3, 6], pa: [-6, -3, 3, 6], ra: [-3, -2, 2, 3] };

// The chance of the over: the market's mean (after the over correction) moved by w towards the model's.
const pOver = (rec, w, P, shift) => {
  const muMkt = rec.muMktBy[shift == null ? rec.shift : shift];
  const mu = muMkt + w * (rec.muModel - muMkt);
  const r = B.dist(mu, P.disp[rec.m]).line(rec.line);
  return r.over / (r.over + r.under);
};
const SHIFTS = [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04];
const clampP = (p) => Math.min(0.999, Math.max(0.001, p));
function fitShift(recs) {
  let best = null;
  SHIFTS.forEach((s) => {
    let ll = 0;
    recs.forEach((r) => { const p = clampP(r.pFair - s); ll += r.y ? Math.log(p) : Math.log(1 - p); });
    if (!best || ll > best.ll) best = { ll, s };
  });
  return best.s;
}
function fitWeight(recs, P, shift) {
  let best = null;
  for (let w = 0; w <= 1.0001; w += 0.05) {
    let ll = 0;
    recs.forEach((rec) => { const p = clampP(pOver(rec, w, P, shift)); ll += rec.y ? Math.log(p) : Math.log(1 - p); });
    if (!best || ll > best.ll) best = { ll, w: Math.round(w * 100) / 100 };
  }
  return best.w;
}

function strategy(name, recs, pick) {
  let n = 0, won = 0, profit = 0, sq = 0;
  recs.forEach((rec) => {
    const side = pick(rec);
    if (!side) return;
    const dec = side === 'over' ? rec.over : rec.under;
    const win = side === 'over' ? rec.y === 1 : rec.y === 0;
    const pr = win ? dec - 1 : -1;
    n++; won += win ? 1 : 0; profit += pr; sq += pr * pr;
  });
  const roi = n ? profit / n : null;
  const se = n > 1 ? Math.sqrt((sq / n - roi * roi) / n) : null;
  out((name + '                                                   ').slice(0, 50) + '| ' + String(n).padStart(5) + ' | ' + (n ? (100 * won / n).toFixed(1) + '%' : '-').padStart(6) + ' | ' + pc(roi).padStart(7) + ' ± ' + (se != null ? (196 * se).toFixed(1) + '%' : '-'));
  return { n, roi };
}

async function marketPart(set26, F, P) {
  out('\nAgainst the market: DraftKings closing lines, 2026-27 up to ' + D.yesterday());
  const recs = await marketRecords(set26, F, P);
  out(recs.length + ' player lines with a result (pushes and players who did not play left out)');

  // Over correction, stat by stat, out of sample: fit on even days, test on odd days, and back.
  const folds = [recs.filter((r) => r.day % 2 === 0), recs.filter((r) => r.day % 2 === 1)];
  const shiftBy = {};
  B.MARKET_IDS.forEach((m) => {
    const all = recs.filter((r) => r.m === m);
    if (!all.length) return;
    const pick = (rs) => (all.length < 300 ? rs : rs.filter((r) => r.m === m)); // few lines: use every stat
    shiftBy[m] = fitShift(pick(recs));
    const fa = fitShift(pick(folds[0])), fb = fitShift(pick(folds[1]));
    folds[0].filter((r) => r.m === m).forEach((r) => { r.shift = fb; });
    folds[1].filter((r) => r.m === m).forEach((r) => { r.shift = fa; });
  });
  out('\nOver correction (points taken off the market chance of the over), all days / even / odd:');
  B.MARKET_IDS.forEach((m) => {
    const a = recs.filter((r) => r.m === m);
    if (!a.length) return;
    const ev = a.filter((r) => r.day % 2 === 0)[0], od = a.filter((r) => r.day % 2 === 1)[0];
    out('  ' + (m + '    ').slice(0, 4) + (100 * shiftBy[m]).toFixed(1) + ' / ' + (od ? (100 * od.shift).toFixed(1) : '-') + ' / ' + (ev ? (100 * ev.shift).toFixed(1) : '-') +
      '  (' + a.length + ' lines: market said ' + (100 * a.reduce((t, x) => t + x.pFair, 0) / a.length).toFixed(1) + '%, went over ' + (100 * a.reduce((t, x) => t + x.y, 0) / a.length).toFixed(1) + '%)');
  });

  // The spread around the market's mean (what prices the ladders), refit twice as the mean depends on it.
  const disp = {};
  B.MARKET_IDS.forEach((m) => {
    const rs = recs.filter((r) => r.m === m);
    if (rs.length < 100) { disp[m] = P.disp[m]; return; }
    let d = P.disp[m];
    for (let it = 0; it < 2; it++) {
      const mus = rs.map((r) => B.impliedMean(r.line, Math.max(0.01, r.pFair - shiftBy[m]), d));
      let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
      rs.forEach((r, i) => { const mu = mus[i], y = (r.act - mu) * (r.act - mu); s11 += mu * mu; s12 += mu * mu * mu; s22 += mu * mu * mu * mu; t1 += y * mu; t2 += y * mu * mu; });
      const det = s11 * s22 - s12 * s12;
      const a0 = Math.min(5, Math.max(0.5, det ? (t1 * s22 - t2 * s12) / det : d[0])), b0 = Math.min(0.2, Math.max(0, det ? (s11 * t2 - s12 * t1) / det : d[1]));
      let best = null;
      [-0.3, -0.15, 0, 0.15, 0.3].forEach((da) => [0, 0.5, 1, 1.5, 2].forEach((fb) => {
        const dd = [Math.max(0.5, a0 + da), fb === 0 ? 0 : (b0 || 0.01) * fb];
        let ll = 0;
        rs.forEach((r, i) => { ll += B.logLik(r.act, mus[i], dd); });
        if (!best || ll > best.ll) best = { ll, dd };
      }));
      d = best.dd.map((x) => Math.round(x * 1000) / 1000);
    }
    // The tail cut: whatever prices the rungs above the line best (Brier), the main line included.
    const st = (LADDER_STEPS[m] || [2]).filter((x) => x > 0).concat([0]);
    const mus = rs.map((r) => B.impliedMean(r.line, Math.max(0.01, r.pFair - shiftBy[m]), d));
    let bestC = null;
    [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4].forEach((c) => {
      const dd = [d[0], d[1], c];
      let br = 0;
      rs.forEach((r, i) => {
        const D = B.dist(mus[i], dd);
        st.forEach((dk) => { const k = Math.floor(r.line) + 1 + dk; const p = D.atLeast(k); const y = r.act >= k ? 1 : 0; br += (p - y) * (p - y); });
      });
      if (!bestC || br < bestC.br) bestC = { br, c };
    });
    if (bestC.c > 0) d = [d[0], d[1], bestC.c];
    disp[m] = d;
  });
  out("\nSpread around the market's mean (variance = a × mean + b × mean²): " + B.MARKET_IDS.map((m) => m + ' [' + disp[m].join(', ') + ']').join(', '));
  out("Spread around the model's mean, for comparison: " + B.MARKET_IDS.map((m) => m + ' [' + P.disp[m].join(', ') + ']').join(', '));
  P = B.params(Object.assign({}, P, { disp }));
  recs.forEach((r) => { r.muMkt = B.impliedMean(r.line, Math.max(0.01, r.pFair - shiftBy[r.m]), P.disp[r.m]); });

  // Ladders ("25+") sit away from the main line: does the distribution get those chances right?
  out('\nLadder check: chance of reaching the main line plus or minus a few, said against happened');
  const steps = LADDER_STEPS;
  Object.keys(steps).forEach((m) => {
    const rs = recs.filter((r) => r.m === m);
    if (rs.length < 200) return;
    out('  ' + (m + '    ').slice(0, 4) + steps[m].map((dk) => {
      let said = 0, hap = 0;
      rs.forEach((r) => { const k = Math.floor(r.line) + 1 + dk; said += B.dist(r.muMkt, P.disp[m]).atLeast(k); hap += r.act >= k ? 1 : 0; });
      return (dk > 0 ? '+' : '') + dk + ': ' + (100 * said / rs.length).toFixed(1) + '% v ' + (100 * hap / rs.length).toFixed(1) + '%';
    }).join(' | '));
  });
  log('  pricing the market at each over correction...');
  recs.forEach((r) => { r.muMktBy = {}; SHIFTS.forEach((s) => { r.muMktBy[s] = B.impliedMean(r.line, Math.max(0.01, r.pFair - s), P.disp[r.m]); }); });

  out('\nMarket chance of the over (margin removed) against how often it went over:');
  [[0, 0.4], [0.4, 0.47], [0.47, 0.53], [0.53, 0.6], [0.6, 1]].forEach(([a, b]) => {
    const r = recs.filter((x) => x.pFair >= a && x.pFair < b);
    if (r.length) out('  ' + a.toFixed(2) + '-' + b.toFixed(2) + ': said ' + (100 * r.reduce((t, x) => t + x.pFair, 0) / r.length).toFixed(1) + '%, went over ' + (100 * r.reduce((t, x) => t + x.y, 0) / r.length).toFixed(1) + '% (' + r.length + ')');
  });

  const weights = {};
  out('\nWeight of the model against the corrected market (0 = market only, 1 = model only); log loss per line, lower is better:');
  out('Stat  | weight (all) | even | odd  | market | corrected | model | blend (out of sample)');
  B.MARKET_IDS.forEach((m) => {
    const all = recs.filter((r) => r.m === m);
    if (all.length < 50) return;
    const a = folds[0].filter((r) => r.m === m), b = folds[1].filter((r) => r.m === m);
    const wa = fitWeight(a, P), wb = fitWeight(b, P);
    weights[m] = fitWeight(all, P, shiftBy[m]);
    a.forEach((r) => { r.cvw = wb; });
    b.forEach((r) => { r.cvw = wa; });
    const loss = (f) => -all.reduce((t, r) => { const p = clampP(f(r)); return t + (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / all.length;
    out((m + '     ').slice(0, 6) + '| ' + f2(weights[m]).padStart(12) + ' | ' + f2(wa) + ' | ' + f2(wb) + ' | ' + f3(loss((r) => r.pFair)) + '  | ' + f3(loss((r) => r.pFair - r.shift)) + '     | ' +
      f3(loss((r) => pOver(r, 1, P, 0))) + ' | ' + f3(loss((r) => pOver(r, r.cvw, P))) + '   (' + all.length + ')');
  });

  const evSide = (r, p) => {
    const eo = p * r.over - 1, eu = (1 - p) * r.under - 1;
    return eo >= eu ? { side: 'over', ev: eo } : { side: 'under', ev: eu };
  };
  const usable = recs.filter((r) => r.cvw != null);
  out('\nBetting every pick at DraftKings closing odds, 1 unit each (± is a 95% range):');
  out('Rule                                              |  bets |    won |     ROI');
  [0, 0.02, 0.04].forEach((t) => strategy('Corrected market + model, edge ' + (100 * t) + '%+', usable, (r) => { const e = evSide(r, pOver(r, r.cvw, P)); return e.ev >= t ? e.side : null; }));
  [0, 0.02].forEach((t) => strategy('Corrected market alone, edge ' + (100 * t) + '%+', usable, (r) => { const e = evSide(r, r.pFair - r.shift); return e.ev >= t ? e.side : null; }));
  strategy('Model alone (no market), edge 5%+', recs, (r) => { const e = evSide(r, pOver(r, 1, P, 0)); return e.ev >= 0.05 ? e.side : null; });
  strategy('Linemaker: over v bottom-5 D, under v top-5', recs, (r) => (!r.rank ? null : r.rank.rank <= 5 ? 'over' : r.rank.rank > r.rank.of - 5 ? 'under' : null));
  strategy('Linemaker, overs only', recs, (r) => (r.rank && r.rank.rank <= 5 ? 'over' : null));
  strategy('Linemaker, unders only', recs, (r) => (r.rank && r.rank.rank > r.rank.of - 5 ? 'under' : null));
  strategy('Hit rate: over if 7+ of last 10, under if 3-', recs, (r) => (r.hit10 == null ? null : r.hit10 >= 7 ? 'over' : r.hit10 <= 3 ? 'under' : null));
  strategy('Every over', recs, () => 'over');
  strategy('Every under', recs, () => 'under');
  strategy('Every under at even money or better (2.00+)', recs, (r) => (r.under >= 2 ? 'under' : null));
  const marg = recs.reduce((t, r) => t + r.margin, 0) / recs.length;
  out('Average DraftKings margin on these lines: ' + (100 * marg).toFixed(1) + '%');
  return { weights, shift: shiftBy, disp };
}

/* ---------------------------------------------------------------- main */

(async () => {
  const t0 = Date.now();
  let P = B.params();
  log('Loading 2025-26 and 2024-25 (positions, game logs, closing totals)...');
  const s26 = await loadSeason(2026);
  const s25 = await loadSeason(2025);
  const F26 = factorsFor(s25, s26.avgTotal); // what was known before 2025-26: last season's defences
  if (!MARKET_ONLY) {
    const prior26 = await priorRows(2025, s26.players.map((p) => p.id));
    const prior25 = await priorRows(2024, s25.players.map((p) => p.id));
    const s24players = [];
    const pos24 = await D.positions(2024, D.cachedIds(2024));
    for (const id of D.cachedIds(2024)) if (pos24[id] && prior25[id]) s24players.push({ id, grp: B.posGroup(pos24[id].pos), rows: prior25[id] });
    const F25 = B.buildStatFactors(s24players, { avgTotal: s25.avgTotal });

    log('Fitting recency and prior weights on 2025-26...');
    let best = null;
    [6, 10, 15, 25, 50].forEach((halfLife) => [3, 5, 8, 12].forEach((minHalfLife) => [4, 8, 12, 20].forEach((priorGames) => [1, 3, 6].forEach((priorMinGames) => {
      const Q = B.params({ halfLife, minHalfLife, priorGames, priorMinGames });
      const sc = baseScore(s26, prior26, F26, Q);
      if (!best || sc.score < best.score) best = { score: sc.score, Q, sc };
    }))));
    P = best.Q;
    out('Recency and prior: rates halve every ' + P.halfLife + ' games, minutes every ' + P.minHalfLife + '; last season counts as ' + P.priorGames + ' games (minutes ' + P.priorMinGames + ')');
    const recs26 = records(s26, prior26, F26, P);
    log('Fitting opponent, game total and blowout on ' + recs26.length + ' player-games...');
    P = fitContext(recs26, F26, P, best.sc.naive);
    out('Blowout: starters lose ' + (100 * P.gamma).toFixed(1) + '% of minutes per point of spread beyond ' + P.blowFrom);
    out('Opponent strength: ' + B.BASE.map((s) => s + ' ' + P.alpha[s]).join(', '));
    out('Game total strength: ' + B.BASE.map((s) => s + ' ' + P.beta[s]).join(', '));
    P = fitDispersion(recs26, F26, P);
    out('Spread (variance = a × mean + b × mean²): ' + B.MARKET_IDS.map((m) => m + ' [' + P.disp[m].join(', ') + ']').join(', '));
    report('2025-26, the season the settings were fitted on', recs26, F26, P);
    report('2024-25, a season they were not fitted on', records(s25, prior25, F25, P), F25, P);
  }
  const mk = await marketPart(s26, factorsFor(s26), P);
  out('\nFor web/bets.js DEFAULTS:');
  out(JSON.stringify({ halfLife: P.halfLife, minHalfLife: P.minHalfLife, priorGames: P.priorGames, priorMinGames: P.priorMinGames, alpha: P.alpha, beta: P.beta, gamma: P.gamma, blowFrom: P.blowFrom, disp: mk.disp, overShift: mk.shift, weight: mk.weights }));
  log('Done in ' + Math.round((Date.now() - t0) / 1000) + ' s, ' + D.requests() + ' requests to ESPN.');
})().catch((e) => { log('FAILED ' + (e.stack || e.message)); process.exitCode = 1; });
