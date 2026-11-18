'use strict';
const test = require('node:test');
const assert = require('node:assert');
globalThis.WPBets = require('../web/bets.js');
const B = globalThis.WPBets;
const K = require('../web/picklog.js');

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol), a + ' !~ ' + b);
const NOW = Date.parse('2026-11-17T18:00:00Z');

// A board with one line and the given bets, as WPBets.buildBoard returns it.
function board(bets, gameOver) {
  const game = Object.assign({ id: '401', start: NOW + 3600e3, state: 'pre' }, gameOver || {});
  const entry = {
    key: '7|pts', id: '7', name: 'Some Guard', m: 'pts', game, ctx: { team: 'HOM', opp: 'AWY' },
    pr: { anchor: { line: 22.5, L: { over: 1.91, under: 1.91 } } },
  };
  return { picks: bets.map((b) => Object.assign({ entry, key: '7|pts|' + b.book + '|' + b.side + '|' + b.line }, b)) };
}
const NIGHT = { date: '2026-11-17' };

test('fromBoard logs value picks at Betano and Betclic before tip-off only', () => {
  const b = board([
    { book: 'Betano', side: 'under', line: 23.5, dec: 2.2, p: 0.5, ev: 0.1 },
    { book: 'DraftKings', side: 'over', line: 22.5, dec: 2.5, p: 0.5, ev: 0.25 }, // not bettable from Portugal
    { book: 'Betclic', side: 'over', line: 21.5, dec: 1.7, p: 0.55, ev: -0.065 }, // not value
  ]);
  const recs = K.fromBoard(b, NIGHT, NOW);
  assert.strictEqual(recs.length, 1);
  const r = recs[0];
  assert.strictEqual(r.id, '2026-11-17|401|7|pts|Betano|under|23.5');
  assert.deepStrictEqual([r.athlete, r.event, r.book, r.side, r.line, r.flagged], ['7', '401', 'Betano', 'under', 23.5, true]);
  assert.deepStrictEqual(r.first.dk, { line: 22.5, over: 1.91, under: 1.91 });
  assert.strictEqual(K.fromBoard(board([{ book: 'Betano', side: 'under', line: 23.5, dec: 2.2, p: 0.5, ev: 0.1 }], { state: 'in' }), NIGHT, NOW).length, 0);
  assert.strictEqual(K.fromBoard(board([{ book: 'Betano', side: 'under', line: 23.5, dec: 2.2, p: 0.5, ev: 0.1 }], { start: NOW - 1 }), NIGHT, NOW).length, 0);
});

test('merge keeps the first sighting, follows the latest price, never touches graded picks', () => {
  const pick = (dec, ev, at) => K.fromBoard(board([{ book: 'Betano', side: 'under', line: 23.5, dec, p: 0.5, ev }]), NIGHT, at)[0];
  const log = {};
  assert.strictEqual(K.merge(log, [pick(2.2, 0.1, NOW)]).length, 1);
  assert.strictEqual(K.merge(log, [pick(2.2, 0.1, NOW + 60e3)]).length, 0); // nothing moved
  const ch = K.merge(log, [pick(2.1, 0.05, NOW + 120e3)]);
  assert.strictEqual(ch.length, 1);
  const r = log[ch[0].id];
  assert.strictEqual(r.first.dec, 2.2);
  assert.strictEqual(r.last.dec, 2.1);
  log[r.id] = Object.assign({}, r, { result: { outcome: 'win' } });
  assert.strictEqual(K.merge(log, [pick(1.9, 0.01, NOW + 1800e3)]).length, 0);
});

test('a placed bet that later shows as value becomes flagged with that first sighting', () => {
  const b = board([{ book: 'Betano', side: 'under', line: 23.5, dec: 2.2, p: 0.5, ev: 0.1 }]);
  const placed = Object.assign(K.record(b.picks[0], NIGHT.date, NOW - 1000, false), { placed: { stake: 10, dec: 2.2, at: NOW - 1000 } });
  const log = { [placed.id]: placed };
  K.merge(log, K.fromBoard(b, NIGHT, NOW));
  assert.strictEqual(log[placed.id].flagged, true);
  assert.strictEqual(log[placed.id].placed.stake, 10);
  assert.strictEqual(log[placed.id].first.at, NOW);
});

test('outcome: over, under, pushes and ladders', () => {
  assert.strictEqual(K.outcome('over', 22.5, 23), 'win');
  assert.strictEqual(K.outcome('under', 22.5, 23), 'loss');
  assert.strictEqual(K.outcome('under', 22, 22), 'push');
  assert.strictEqual(K.outcome('atleast', 25, 25), 'win');
  assert.strictEqual(K.outcome('atleast', 25, 24), 'loss');
});

const rec = (o) => Object.assign({
  id: 'x', date: '2026-11-17', event: '401', athlete: '7', m: 'pts', book: 'Betano', side: 'under', line: 23.5, flagged: true,
  first: { at: NOW, dec: 2.2, p: 0.5, ev: 0.1 },
}, o);
const rows = (o) => [Object.assign({ id: '401', date: '2026-11-17', pts: 20, reb: 5, ast: 3, tpm: 1, stl: 1, blk: 0, min: 30 }, o)];

test('grade: result from the box score, closing-line value from DraftKings closing line', () => {
  const close = { players: { 7: { markets: { pts: { lines: [{ line: 22.5, over: 1.91, under: 1.91 }], ladder: [] } } } } };
  const P = B.params({ overShift: { pts: 0.025 }, disp: { pts: [3.4, 0] } });
  const g = K.grade(rec(), rows(), close, P, NOW + 864e5);
  assert.deepStrictEqual([g.result.outcome, g.result.v], ['win', 20]);
  const pr = B.price({ m: 'pts', books: [{ book: 'DraftKings', mk: close.players[7].markets.pts }], muModel: null, P });
  near(g.close.p, pr.dist.line(23.5).under, 1e-4);
  near(g.close.clv, g.close.p * 2.2 - 1, 1e-4);
  assert.strictEqual(K.grade(g, rows(), close, P, NOW), null); // graded once
});

test('grade: void only once his log has moved on or two days have passed', () => {
  const later = [{ id: '999', date: '2026-11-19', pts: 10 }];
  assert.strictEqual(K.grade(rec(), [], null, B.DEFAULTS, NOW + 864e5), null); // the log may just be late
  assert.strictEqual(K.grade(rec(), later, null, B.DEFAULTS, NOW + 864e5).result.outcome, 'void');
  assert.strictEqual(K.grade(rec(), [], null, B.DEFAULTS, NOW + 3 * 864e5).result.outcome, 'void');
  assert.strictEqual(K.grade(rec(), null, null, B.DEFAULTS, NOW + 3 * 864e5), null); // his log could not be read
});

test('summary: units, record, closing-line value and your stakes', () => {
  const log = {
    a: rec({ id: 'a', result: { outcome: 'win', v: 20 }, close: { clv: 0.05 }, placed: { stake: 10, dec: 2.0 } }),
    b: rec({ id: 'b', date: '2026-11-18', first: { dec: 1.8, ev: 0.04 }, result: { outcome: 'loss', v: 30 }, close: { clv: -0.01 } }),
    c: rec({ id: 'c', result: { outcome: 'void', v: null } }),
    d: rec({ id: 'd', date: '2026-11-19' }),
    e: rec({ id: 'e', flagged: false, placed: { stake: 5, dec: 1.9 }, result: { outcome: 'loss', v: 30 } }),
  };
  const s = K.summary(log);
  assert.deepStrictEqual([s.all.n, s.all.settled, s.all.pending, s.all.win, s.all.loss, s.all.void], [4, 2, 1, 1, 1, 1]);
  near(s.all.units, 1.2 - 1);
  near(s.all.roi, 0.1);
  near(s.all.expected, 0.14);
  near(s.all.clvAvg, 0.02);
  assert.deepStrictEqual(s.series.map((x) => [x.date, Math.round(x.units * 100) / 100]), [['2026-11-17', 1.2], ['2026-11-18', 0.2]]);
  assert.deepStrictEqual([s.placed.n, s.placed.settled], [2, 2]);
  near(s.placed.staked, 15);
  near(s.placed.profit, 10 - 5);
  assert.strictEqual(s.byBook.Betano.n, 4);
});

test('records say how long before tip-off and whether DraftKings had moved; the summary splits on both', () => {
  const b = board([{ book: 'Betano', side: 'over', line: 23.5, dec: 2.2, p: 0.5, ev: 0.1, withMove: true }]);
  b.picks[0].entry.pr.early = true; b.picks[0].entry.pr.w = 0.2; // would be early, but the move comes first
  const r = K.fromBoard(b, NIGHT, NOW)[0];
  assert.deepStrictEqual([r.withMove, r.early], [true, true]);
  assert.strictEqual(K.timing(r), '1-3h'); // tip-off an hour after NOW
  assert.strictEqual(K.timing(Object.assign({}, r, { start: NOW + 4 * 3600e3 })), '3h+');
  assert.strictEqual(K.timing(Object.assign({}, r, { start: NOW + 20 * 60e3 })), 'under 1h');
  assert.strictEqual(K.timing(Object.assign({}, r, { start: null })), 'unknown');
  const log = {
    a: rec({ id: 'a', start: NOW + 3600e3, withMove: true, result: { outcome: 'win', v: 20 } }),
    b: rec({ id: 'b', start: NOW + 5 * 3600e3, early: true, result: { outcome: 'loss', v: 30 } }),
    c: rec({ id: 'c', start: NOW + 5 * 3600e3 }),
  };
  const s = K.summary(log);
  assert.deepStrictEqual(Object.keys(s.byTiming).sort(), ['1-3h', '3h+']);
  assert.deepStrictEqual([s.byMove.moved.n, s.byMove.early.n, s.byMove.other.n], [1, 1, 1]);
});
