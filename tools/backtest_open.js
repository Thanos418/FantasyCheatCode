#!/usr/bin/env node
/* Backtest of DraftKings' OPENING player lines against its closing lines (2026-27 so far). ESPN keeps
   both for the season in progress, so this measures what the Bets view cannot see in one snapshot:

   1. How much DraftKings moves between the open and the close.
   2. A stale book: one still on DraftKings' opening line and price when DraftKings has closed. Its value
      is measured against the corrected closing line, then settled on the box score. If the promised
      edge comes back as profit, the fair price is right even on lines other than DraftKings' own.
   3. Following the move: when DraftKings moved its line, the old line in the direction of the move.
   4. Early weights: how far our projection should move DraftKings' line while that line is still at
      its opening price (web/bets.js DEFAULTS.weightEarly), fitted on even days and tested on odd days
      and the other way round, judged by closing-line value and by results.

   The projection here has no game context (opponent, venue, rest, total), so the weights are slightly
   conservative for the app's own projection. Public ESPN data only; it shares tools/props_data.js's cache.

     node tools/backtest_open.js
*/
'use strict';
const D = require('./props_data.js');
const B = require('../web/bets.js');

const log = (s) => process.stderr.write(s + '\n');
const out = (s) => process.stdout.write(s + '\n');
const pc = (x) => (x == null || !isFinite(x) ? '-' : (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%');
const clamp = (p) => Math.min(0.98, Math.max(0.02, p));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ci = (a) => { const m = mean(a); return 1.96 * Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / Math.max(1, a.length - 1) / a.length); };
const WEIGHTS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
const SINGLE = ['reb', 'ast', 'tpm', 'stl', 'blk', 'ra']; // where the projection earned a weight

async function records(P) {
  const games = await D.seasonGames(2027, log);
  log('  reading DraftKings lines for ' + games.length + ' games...');
  const props = await D.pool(games, 8, (g) => D.gameProps(g.id));
  const books = games.map((g, i) => ({ g, book: props[i] ? B.parseEspnProps(props[i]) : null })).filter((x) => x.book && Object.keys(x.book.players).length);
  const ids = [...new Set([].concat(...books.map((x) => Object.keys(x.book.players))))];
  log('  ' + books.length + ' games with lines, ' + ids.length + ' players; reading game logs...');
  const rows27 = {}, rows26 = {};
  await D.pool(ids, 8, async (id) => { rows27[id] = await D.playerRows(2027, id, null); rows26[id] = await D.playerRows(2026, id, null); });
  const recs = [];
  books.forEach(({ g, book }) => Object.keys(book.players).forEach((id) => {
    const rows = rows27[id] || [];
    const act = rows.find((r) => r.id === g.id);
    if (!act) return; // did not play: void
    const proj = B.projector(rows26[id], P, null);
    rows.filter((r) => r.date < g.date).forEach((r) => proj.push(r));
    const base = proj.base();
    Object.keys(book.players[id].markets).forEach((m) => {
      const L = B.mainLine(book.players[id].markets[m]);
      const o = L && L.open;
      if (!L || !(L.line > 0) || !o || !(o.line > 0) || !(o.over > 1) || !(o.under > 1)) return;
      const d = P.disp[m];
      const day = +g.date.slice(8, 10);
      recs.push({
        m, fold: day % 2, d, line: L.line, over: L.over, under: L.under, oline: o.line, oover: o.over, ounder: o.under,
        pC: B.devig(L.over, L.under).over, pO: B.devig(o.over, o.under).over, act: B.statOf(act, m),
        muModel: base ? base.min * B.MARKETS[m].parts.reduce((t, s) => t + (base.rate[s] || 0), 0) : null,
      });
    });
  }));
  return recs;
}

const profit = (side, L, dec, act) => (act === L ? 0 : (side === 'over' ? act > L : act < L) ? dec - 1 : -1);
const evAt = (mu, d, L, side, dec) => { const q = B.dist(mu, d).line(L); return (side === 'over' ? q.over : q.under) * dec + q.push - 1; };
const best = (mu, d, L, o, u) => { const eo = evAt(mu, d, L, 'over', o), eu = evAt(mu, d, L, 'under', u); return eo >= eu ? { side: 'over', ev: eo, dec: o } : { side: 'under', ev: eu, dec: u }; };
const shade = (dec, extra) => 1 / (1 / dec + extra / 2); // a book with the same fair prices and a bigger margin
function row(name, bets) {
  if (!bets.length) return out('  ' + name + ': none');
  const pn = bets.map((b) => b.pnl), cl = bets.filter((b) => b.clv != null).map((b) => b.clv);
  out('  ' + (name + ' '.repeat(50)).slice(0, 50) + String(bets.length).padStart(6) + ' | ROI ' + pc(mean(pn)).padStart(6) + ' ± ' + (100 * ci(pn)).toFixed(1) + '%' +
    (bets[0].ev != null ? ' | promised ' + pc(mean(bets.map((b) => b.ev))) : '') + (cl.length ? ' | CLV ' + pc(mean(cl)) + ' ± ' + (100 * ci(cl)).toFixed(1) + '%' : ''));
}
// Log likelihood of the over at the opening line for a weight of the model against the open.
function fitW(rs) {
  let bestW = null;
  WEIGHTS.forEach((w) => {
    let ll = 0;
    rs.forEach((r) => {
      if (r.act === r.oline) return;
      const q = B.dist(r.muO + w * (r.muModel - r.muO), r.d).line(r.oline);
      const p = Math.min(0.999, Math.max(0.001, q.over / (q.over + q.under)));
      ll += r.act > r.oline ? Math.log(p) : Math.log(1 - p);
    });
    if (!bestW || ll > bestW.ll) bestW = { ll, w };
  });
  return bestW.w;
}

(async () => {
  const P = B.params();
  const recs = await records(P);
  recs.forEach((r) => {
    const sh = P.overShift[r.m] || 0;
    r.muC = B.impliedMean(r.line, clamp(r.pC - sh), r.d);
    r.muO = B.impliedMean(r.oline, clamp(r.pO - sh), r.d);
  });
  out('DraftKings opening v closing player lines, 2026-27 up to ' + D.yesterday() + ': ' + recs.length + ' main lines with a result');

  out('\n1. Movement: the line changed in ' + pc(recs.filter((r) => r.oline !== r.line).length / recs.length) + ' of cases');
  B.MARKET_IDS.forEach((m) => {
    const rs = recs.filter((r) => r.m === m);
    if (rs.length) out('  ' + m.padEnd(4) + ' moved ' + pc(rs.filter((r) => r.oline !== r.line).length / rs.length).padStart(6) + ', mean move of the implied mean ' + mean(rs.map((r) => Math.abs(r.muC - r.muO))).toFixed(2) + ' (' + rs.length + ')');
  });

  out('\n2. A stale book at DraftKings\' opening price, value judged by the corrected close, settled on results');
  [0, 0.02, 0.04, 0.06, 0.1].forEach((t) => {
    const bets = [];
    recs.forEach((r) => { const b = best(r.muC, r.d, r.oline, r.oover, r.ounder); if (b.ev >= t) bets.push({ pnl: profit(b.side, r.oline, b.dec, r.act), ev: b.ev }); });
    row('edge ' + 100 * t + '%+', bets);
  });
  out('  the same with a bigger margin than DraftKings\', edge 3%+:');
  [0.02, 0.04, 0.06].forEach((x) => {
    const bets = [];
    recs.forEach((r) => { const b = best(r.muC, r.d, r.oline, shade(r.oover, x), shade(r.ounder, x)); if (b.ev >= 0.03) bets.push({ pnl: profit(b.side, r.oline, b.dec, r.act), ev: b.ev }); });
    row('margin +' + 100 * x + ' points', bets);
  });

  out('\n3. Following the move: the opening line, on the side DraftKings moved towards');
  [0, 0.02, 0.04].forEach((x) => {
    const bets = [];
    recs.forEach((r) => {
      if (r.oline === r.line) return;
      const side = r.line > r.oline ? 'over' : 'under';
      bets.push({ pnl: profit(side, r.oline, shade(side === 'over' ? r.oover : r.ounder, x), r.act) });
    });
    row(x ? 'margin +' + 100 * x + ' points' : 'at DraftKings\' margin', bets);
  });

  out('\n4. Early: our projection against the OPENING line, bet at the opening price (no hindsight)');
  const wm = recs.filter((r) => r.muModel > 0);
  const wOf = {}, wAll = {};
  B.MARKET_IDS.forEach((m) => {
    [0, 1].forEach((f) => { wOf[f + m] = fitW(wm.filter((r) => r.m === m && r.fold !== f)); });
    wAll[m] = fitW(wm.filter((r) => r.m === m));
  });
  out('  weight (even days / odd days / all): ' + B.MARKET_IDS.map((m) => m + ' ' + wOf['0' + m] + '/' + wOf['1' + m] + '/' + wAll[m]).join(', '));
  const early = (t, x, keep) => {
    const bets = [];
    wm.forEach((r) => {
      if (keep && !keep(r)) return;
      const w = wOf[r.fold + r.m];
      const b = best(r.muO + w * (r.muModel - r.muO), r.d, r.oline, shade(r.oover, x), shade(r.ounder, x));
      if (b.ev >= t) bets.push({ pnl: profit(b.side, r.oline, b.dec, r.act), ev: b.ev, clv: evAt(r.muC, r.d, r.oline, b.side, b.dec) });
    });
    return bets;
  };
  const single = (r) => SINGLE.indexOf(r.m) >= 0;
  [0, 0.02, 0.04].forEach((t) => row(SINGLE.join(' ') + ', edge ' + 100 * t + '%+', early(t, 0, single)));
  row('every stat, edge 2%+', early(0.02, 0));
  row(SINGLE.join(' ') + ', edge 2%+, margin +2 points', early(0.02, 0.02, single));

  const keep = {};
  B.MARKET_IDS.forEach((m) => { if (SINGLE.indexOf(m) >= 0 && wAll[m] > 0) keep[m] = wAll[m]; });
  out('\nFor web/bets.js DEFAULTS:');
  out(JSON.stringify({ weightEarly: keep }));
  log('Done, ' + D.requests() + ' requests to ESPN.');
})().catch((e) => { log('FAILED ' + (e.stack || e.message)); process.exitCode = 1; });
