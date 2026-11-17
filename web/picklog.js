/* The Bets track record. Pure functions, no DOM, no network.

   Every value pick the Bets view shows at a book you can bet at (Betano, Betclic) is logged the first
   time it appears, with its price and expected value then, and its latest price until tip-off. The
   next day each pick is graded from the box score (win, loss, push, or void when he did not play) and
   priced against DraftKings' closing line: closing-line value says whether the market moved towards the
   pick, which shows an edge long before results do. Bets you mark as placed carry your stake.

   A record: { id, date, event, start, athlete, name, team, opp, m, book, side, line, flagged,
   first: snap, last: snap, placed?: { stake, dec, at }, result?: { outcome, v, at },
   close?: { line, over, under, p, clv } } with snap = { at, dec, p, ev, dk: { line, over, under } }. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WPPicks = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const bets = () => root.WPBets || (typeof require === 'function' ? require('./bets.js') : null);
  const BETTABLE = ['Betano', 'Betclic'];
  const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);
  const DAY = 864e5;

  const pickId = (date, p) => [date, p.entry.game.id, p.entry.id, p.entry.m, p.book, p.side, p.line].join('|');

  function snap(p, now) {
    const a = p.entry.pr.anchor;
    return {
      at: now, dec: p.dec, p: r4(p.p), ev: r4(p.ev),
      dk: a && a.L ? { line: a.line, over: r4(a.L.over), under: r4(a.L.under) } : null,
    };
  }

  // One pick from the board as a record (flagged: it was value when logged).
  function record(p, date, now, flagged) {
    const L = p.entry, s = snap(p, now);
    return {
      id: pickId(date, p), date, event: L.game.id, start: L.game.start || null, athlete: String(L.id), name: L.name,
      team: L.ctx.team, opp: L.ctx.opp, m: L.m, book: p.book, side: p.side, line: p.line, flagged: !!flagged, first: s, last: s,
    };
  }

  // The board's value picks worth logging: a book you can bet at, a game not started yet.
  function fromBoard(board, night, now) {
    const out = [];
    ((board && board.picks) || []).forEach((p) => {
      if (!(p.ev > 0) || BETTABLE.indexOf(p.book) < 0) return;
      const g = p.entry.game;
      if (g.state && g.state !== 'pre') return;
      if (g.start && now >= g.start) return;
      out.push(record(p, night.date, now, true));
    });
    return out;
  }

  /* Adds new records to log ({ id: record }) and refreshes the latest price of open ones. A pick seen
     again keeps its first sighting; one first logged as a placed bet becomes flagged when it shows up as
     value. Graded records never change. Returns the records that changed, to save. */
  function merge(log, recs) {
    const changed = [];
    recs.forEach((r) => {
      const old = log[r.id];
      if (!old) { log[r.id] = r; changed.push(r); return; }
      if (old.result) return;
      const moved = !old.last || old.last.dec !== r.last.dec || old.last.ev !== r.last.ev || r.last.at - old.last.at >= 30 * 60 * 1000;
      if (!moved && (old.flagged || !r.flagged)) return;
      const n = Object.assign({}, old, { last: r.last });
      if (r.flagged && !old.flagged) { n.flagged = true; n.first = r.first; }
      log[r.id] = n;
      changed.push(n);
    });
    return changed;
  }

  function outcome(side, line, v) {
    if (side === 'atleast') return v >= line ? 'win' : 'loss';
    if (v === line) return 'push';
    return (side === 'over') === (v > line) ? 'win' : 'loss';
  }

  /* Grade one record. rows: the player's games this season (WPBets.normGamelog), or null if they could
     not be read; closeBook: DraftKings' props for the game after it ended (its closing lines), or null.
     Returns the graded record, or null while it cannot be graded yet: no box score for that game and
     nothing yet to say he missed it (a later game in his log, or two days gone by). */
  function grade(rec, rows, closeBook, P, now) {
    const B = bets();
    if (rec.result || !rows) return null;
    const row = rows.find((r) => r.id === String(rec.event));
    let result;
    if (row) {
      const v = B.statOf(row, rec.m);
      result = { outcome: outcome(rec.side, rec.line, v), v, at: now };
    } else {
      const later = rows.some((r) => r.date > rec.date);
      if (!later && now - Date.parse(rec.date + 'T12:00:00Z') < 2 * DAY) return null;
      result = { outcome: 'void', v: null, at: now }; // did not play: books void the bet
    }
    const out = Object.assign({}, rec, { result });
    const mk = closeBook && closeBook.players && closeBook.players[rec.athlete] && closeBook.players[rec.athlete].markets[rec.m];
    if (mk && mk.lines.length) {
      const pr = B.price({ m: rec.m, books: [{ book: 'DraftKings', mk: { lines: mk.lines, ladder: [] } }], muModel: null, P });
      if (pr && pr.anchor) {
        const D = pr.dist;
        let p;
        if (rec.side === 'atleast') p = D.atLeast(rec.line);
        else { const x = D.line(rec.line); p = (rec.side === 'over' ? x.over : x.under) + x.push / 2; }
        out.close = { line: pr.anchor.line, over: r4(pr.anchor.L.over), under: r4(pr.anchor.L.under), p: r4(p), clv: r4(p * rec.first.dec - 1) };
      }
    }
    return out;
  }

  // Records that may be gradable: not graded, from a night before `today` (ET date).
  const ungraded = (log, today) => Object.keys(log).map((k) => log[k]).filter((r) => !r.result && r.date < today);

  // Units won at a decimal price for a graded record (1 unit staked).
  function units(rec, dec) {
    const o = rec.result && rec.result.outcome;
    return o === 'win' ? dec - 1 : o === 'loss' ? -1 : 0;
  }

  function stats(list) {
    const settled = list.filter((r) => r.result && r.result.outcome !== 'void');
    const u = settled.map((r) => units(r, r.first.dec));
    const n = settled.length;
    const total = u.reduce((t, x) => t + x, 0);
    const mean = n ? total / n : null;
    const sd = n > 1 ? Math.sqrt(u.reduce((t, x) => t + (x - mean) * (x - mean), 0) / (n - 1)) : null;
    const clv = settled.filter((r) => r.close && r.close.clv != null).map((r) => r.close.clv);
    const cm = clv.length ? clv.reduce((t, x) => t + x, 0) / clv.length : null;
    const csd = clv.length > 1 ? Math.sqrt(clv.reduce((t, x) => t + (x - cm) * (x - cm), 0) / (clv.length - 1)) : null;
    const count = (o) => list.filter((r) => r.result && r.result.outcome === o).length;
    return {
      n: list.length, settled: n, pending: list.filter((r) => !r.result).length,
      win: count('win'), loss: count('loss'), push: count('push'), void: count('void'),
      units: total, roi: mean, roiSe: sd != null ? sd / Math.sqrt(n) : null,
      expected: n ? settled.reduce((t, r) => t + (r.first.ev || 0), 0) : 0,
      evAvg: n ? settled.reduce((t, r) => t + (r.first.ev || 0), 0) / n : null,
      clvAvg: cm, clvN: clv.length, clvSe: csd != null ? csd / Math.sqrt(clv.length) : null,
    };
  }

  /* The track record: the value picks (flagged), with breakdowns and a running total by night, and
     the bets you placed in euros. */
  function summary(log) {
    const all = Object.keys(log || {}).map((k) => log[k]);
    const flagged = all.filter((r) => r.flagged);
    const by = (key) => {
      const g = {};
      flagged.forEach((r) => { const k = key(r); (g[k] = g[k] || []).push(r); });
      const out = {};
      Object.keys(g).forEach((k) => { out[k] = stats(g[k]); });
      return out;
    };
    const nights = {};
    flagged.filter((r) => r.result && r.result.outcome !== 'void').forEach((r) => {
      const n = (nights[r.date] = nights[r.date] || { date: r.date, units: 0, expected: 0, bets: 0 });
      n.units += units(r, r.first.dec); n.expected += r.first.ev || 0; n.bets++;
    });
    let cu = 0, ce = 0;
    const series = Object.keys(nights).sort().map((d) => { cu += nights[d].units; ce += nights[d].expected; return { date: d, units: cu, expected: ce, bets: nights[d].bets }; });
    const placed = all.filter((r) => r.placed && r.placed.stake > 0);
    const settledP = placed.filter((r) => r.result && r.result.outcome !== 'void');
    const staked = settledP.reduce((t, r) => t + r.placed.stake, 0);
    const profit = settledP.reduce((t, r) => t + r.placed.stake * units(r, r.placed.dec), 0);
    return {
      all: stats(flagged),
      byBook: by((r) => r.book), byStat: by((r) => r.m), bySide: by((r) => (r.side === 'atleast' ? 'ladder' : r.side)),
      series,
      placed: { n: placed.length, settled: settledP.length, pending: placed.filter((r) => !r.result).length, staked, profit, roi: staked ? profit / staked : null, open: placed.filter((r) => !r.result).reduce((t, r) => t + r.placed.stake, 0) },
      recent: all.slice().sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : (b.first.ev || 0) - (a.first.ev || 0))),
    };
  }

  return { BETTABLE, pickId, record, fromBoard, merge, outcome, grade, ungraded, units, stats, summary };
});
