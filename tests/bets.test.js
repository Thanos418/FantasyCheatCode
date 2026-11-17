'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../web/bets.js');

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol), a + ' !~ ' + b);

/* ------------------------------------------------------------ odds maths */

test('american odds to decimal and back', () => {
  near(B.decFromAmerican('-110'), 1.909090909);
  near(B.decFromAmerican('+150'), 2.5);
  near(B.decFromAmerican('EVEN'), 2);
  assert.strictEqual(B.decFromAmerican('abc'), null);
  assert.strictEqual(B.americanFromDec(2.5), '+150');
  assert.strictEqual(B.americanFromDec(1.5), '-200');
});

test('devig removes the margin proportionally', () => {
  const f = B.devig(1.909090909, 1.909090909);
  near(f.over, 0.5);
  near(f.margin, 0.047619, 1e-5);
  const g = B.devig(1.8, 2.1);
  near(g.over + g.under, 1);
  assert.ok(g.over > 0.5);
  assert.strictEqual(B.devig(1, 2), null);
});

test('expected value and Kelly', () => {
  near(B.ev(0.55, 2), 0.1);
  near(B.kelly(0.55, 2), 0.1);
  near(B.kelly(0.5, 2), 0);
});

/* -------------------------------------------------------- distributions */

test('negative binomial: sums to 1, keeps the mean and the variance', () => {
  const d = B.dist(20, [3, 0]);
  let s = 0, m = 0, v = 0;
  for (let k = 0; k <= d.kMax; k++) { s += d.pmf[k]; m += k * d.pmf[k]; }
  for (let k = 0; k <= d.kMax; k++) v += (k - m) * (k - m) * d.pmf[k];
  near(s, 1, 1e-9);
  near(m, 20, 1e-6);
  near(v, 60, 1e-3);
});

test('a Poisson when the variance is not above the mean', () => {
  const d = B.dist(2, [1, 0]);
  near(d.pmf[0], Math.exp(-2), 1e-12);
  near(d.pmf[3], Math.exp(-2) * 8 / 6, 1e-12);
});

test('half lines have no push, whole lines do', () => {
  const d = B.dist(10, [1.5, 0]);
  const h = d.line(9.5);
  near(h.over + h.under, 1);
  assert.strictEqual(h.push, 0);
  const w = d.line(10);
  near(w.over + w.under + w.push, 1);
  near(w.push, d.pmf[10], 1e-12);
});

test('the tail cut lowers rungs above the mean only', () => {
  const plain = B.dist(25, [3.4, 0]), cut = B.dist(25, [3.4, 0, 0.2]);
  near(plain.atLeast(20), cut.atLeast(20)); // below the mean: untouched
  assert.ok(cut.atLeast(32) < plain.atLeast(32));
  const z = (31.5 - 25) / cut.sd;
  near(cut.atLeast(32), plain.atLeast(32) * (1 - 0.2 * z), 1e-12);
  const r = cut.line(31.5);
  near(r.over + r.under, 1);
});

test('impliedMean inverts the chance of the over', () => {
  [[24.5, 0.5], [6.5, 0.6], [1.5, 0.35]].forEach(([line, p]) => {
    const mu = B.impliedMean(line, p, [2, 0]);
    near(B.dist(mu, [2, 0]).line(line).over, p, 1e-4);
  });
  assert.strictEqual(B.impliedMean(10.5, 1, [2, 0]), null);
});

/* ------------------------------------------------------------ game logs */

const LABELS = ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS'];
function rawLog(games) {
  const events = {}, rows = [];
  games.forEach((g, i) => {
    const id = String(1000 + i);
    events[id] = { gameDate: g.t, atVs: g.home ? 'vs' : '@', opponent: { abbreviation: g.opp }, team: { id: g.team || '1' } };
    rows.push({ eventId: id, stats: [String(g.min), g.fg || '5-10', '50', g.tp || '1-3', '33', g.ft || '2-2', '100', String(g.reb), String(g.ast), String(g.blk || 0), String(g.stl || 0), '2', '1', String(g.pts)] });
  });
  return { labels: LABELS, events, seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ events: rows }] }, { displayName: '2026-27 Preseason', categories: [{ events: [] }] }] };
}

test('normGamelog: regular season only, oldest first, no zero-minute games, ET dates', () => {
  const raw = rawLog([
    { t: '2026-11-03T00:30:00.000+00:00', opp: 'BOS', home: true, min: 30, pts: 20, reb: 5, ast: 4, tp: '3-7' },
    { t: '2026-11-01T02:00:00.000+00:00', opp: 'NY', home: false, min: 0, pts: 0, reb: 0, ast: 0 },
    { t: '2026-10-30T23:00:00.000+00:00', opp: 'MIA', home: false, min: 25, pts: 12, reb: 7, ast: 2 },
  ]);
  raw.seasonTypes[1].categories[0].events.push({ eventId: '1000', stats: [] }); // a preseason row is ignored
  const rows = B.normGamelog(raw);
  assert.deepStrictEqual(rows.map((r) => r.opp), ['MIA', 'BOS']);
  assert.strictEqual(rows[1].date, '2026-11-02'); // 00:30 UTC is the evening before in New York
  assert.strictEqual(rows[1].tpm, 3);
  assert.strictEqual(rows[1].tpa, 7);
  assert.strictEqual(rows[1].home, true);
  assert.strictEqual(B.statOf(rows[1], 'pra'), 29);
});

/* ------------------------------------------------------------ projection */

const row = (o) => Object.assign({ min: 30, pts: 20, reb: 6, ast: 4, tpm: 2, stl: 1, blk: 0.5, team: '1', opp: 'BOS', home: true, date: '2026-11-01' }, o);

test('projector: needs minGames, recent games count more, last season is the prior', () => {
  const P = B.params({ halfLife: 2, minHalfLife: 2, priorGames: 0, priorMinGames: 0, minGames: 3 });
  const pj = B.projector([], P);
  pj.push(row({ pts: 10 }));
  pj.push(row({ pts: 10 }));
  assert.strictEqual(pj.base(), null);
  pj.push(row({ pts: 30 }));
  const b = pj.base();
  near(b.min, 30);
  // weights 0.5, 0.707, 1 on 10, 10, 30 points in 30 minutes each
  const w = [0.5, Math.SQRT1_2, 1];
  near(b.rate.pts * 30, (w[0] * 10 + w[1] * 10 + w[2] * 30) / (w[0] + w[1] + w[2]), 1e-9);

  const prev = Array.from({ length: 20 }, () => row({ pts: 30, min: 30 }));
  const withPrior = B.projector(prev, B.params({ halfLife: 1e9, priorGames: 3, priorMinGames: 0, minGames: 3 }));
  [10, 10, 10].forEach((p) => withPrior.push(row({ pts: p })));
  near(withPrior.base().rate.pts * 30, (30 + 3 * 30) / 6, 1e-6); // 3 games of 10 plus 3 prior games of 30
});

test('project: opponent, venue, pace and blowout adjust the mean', () => {
  const F = { avgTotal: 220, stat: { pts: { opp: { G: { BOS: 1.21 } }, home: 1.02, away: 0.98, b2b: 0.97 } } };
  const P = B.params({ alpha: { pts: 0.5 }, beta: { pts: 1 }, gamma: 0.01, blowFrom: 10, blowMin: 26 });
  const base = { min: 30, rate: { pts: 1, reb: 0.2, ast: 0.1, tpm: 0.05, stl: 0.03, blk: 0.02 } };
  const p0 = B.project(base, { opp: 'BOS', home: true, total: 242, spread: -15 }, F, P, 'G');
  near(p0.blow, 0.95, 1e-12); // 5 points of spread beyond 10, 1% each
  near(p0.mu.pts, 30 * 0.95 * 1.1 * 1.02 * 1.1, 1e-9); // sqrt(1.21) · home · 242/220
  near(p0.mu.pr, p0.mu.pts + 30 * 0.95 * 0.2 * Math.pow(242 / 220, P.beta.reb), 1e-9);
  const p1 = B.project(base, { opp: 'XXX', home: false, b2b: true }, F, P, 'G');
  near(p1.mu.pts, 30 * 0.98 * 0.97, 1e-9);
});

test('stat factors: a defence that gives up more gets a factor above 1', () => {
  const mk = (opp, pts) => ({ min: 30, pts, reb: 5, ast: 5, tpm: 1, stl: 1, blk: 1, opp, team: '1', home: true, date: '2026-11-01' });
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(mk('AAA', 30), mk('BBB', 10));
  const F = B.buildStatFactors([{ grp: 'G', rows }], { shrink: 10 });
  assert.ok(F.stat.pts.opp.G.AAA > 1 && F.stat.pts.opp.G.BBB < 1);
  near(F.stat.pts.opp.G.AAA, 1 + 0.5 * 20 / 30, 1e-4); // 30 against an average of 20, shrunk by 20/(20+10)
  near(F.posRates.G.pts, 20 / 30, 1e-4);
  assert.strictEqual(B.oppRank(F, 'pts', 'G', 'AAA').rank, 1);
});

/* --------------------------------------------------------------- books */

const prop = (id, type, line, am, amOpen) => ({ athlete: { $ref: 'athletes/' + id }, type: { id: String(type) }, odds: { american: { value: am, open: amOpen || am } }, current: line == null ? {} : { target: { value: line } }, open: line == null ? {} : { target: { value: line } } });

test('DraftKings props: first of a pair is the over, a milestone corrects the order', () => {
  const book = B.parseEspnProps({ items: [
    prop(7, 1, 24.5, '-120'), prop(7, 1, 24.5, '+100'),
    prop(7, 3, 8.5, '+130'), prop(7, 3, 8.5, '-160'),
    prop(7, 220, 9, '-160'), // 9+ is the over 8.5: it says the pair above was the other way round
  ] });
  const pts = book.players['7'].markets.pts.lines[0];
  near(pts.over, B.decFromAmerican('-120'));
  const reb = book.players['7'].markets.reb.lines[0];
  near(reb.over, B.decFromAmerican('-160'));
  near(reb.under, B.decFromAmerican('+130'));
});

test('DraftKings ladders: a second run (another period) is dropped for the one matching the line', () => {
  const items = [prop(9, 3, 10.5, '-125'), prop(9, 3, 10.5, '-105')];
  [[2, '-592'], [3, '-202'], [4, '+117'], [5, '+252'], [6, '+542'], [7, '+1100']].forEach(([k, a]) => items.push(prop(9, 220, k, a)));
  [[6, '-2300'], [9, '-315'], [10, '-197'], [11, '-126'], [12, '+124']].forEach(([k, a]) => items.push(prop(9, 220, k, a)));
  const mk = B.parseEspnProps({ items }).players['9'].markets.reb;
  assert.deepStrictEqual(mk.ladder.map((x) => x.k), [6, 9, 10, 11, 12]);
});

test('Betano: over/under rows and ladders by player', () => {
  const json = { data: { event: { id: 1, name: 'Toronto Raptors - New York Knicks', startTime: 0, url: '/odds/x/1/', markets: [
    { type: 'X025', tableLayout: { rows: [{ title: 'Jalen Brunson', groupSelections: [{ handicap: 25.5, selections: [{ name: 'Mais de 25.5', price: 1.8 }, { name: 'Menos 25.5', price: 1.72 }] }] }] } },
    { type: 'PLNP', tableLayout: { rows: [{ title: 'Jalen Brunson', groupSelections: [{ handicap: 0, selections: [{ name: '23+', price: 1.47 }, { name: '24+', price: 1.6 }] }] }] } },
    { type: 'FTPO', tableLayout: { rows: [{ title: 'Game', groupSelections: [] }] } },
  ] } } };
  const b = B.parseBetanoEvent(json);
  const p = b.players[B.normName('Jalen Brunson')];
  assert.deepStrictEqual(p.markets.pts.lines, [{ line: 25.5, over: 1.8, under: 1.72 }]);
  assert.deepStrictEqual(p.markets.pts.ladder, [{ k: 23, dec: 1.47 }, { k: 24, dec: 1.6 }]);
  assert.strictEqual(Object.keys(b.players).length, 1);
});

test('Betclic: player over/under and slider ladders from the page state', () => {
  const sel = (name, odds) => ({ selectionOneof: { selection: { name, odds } } });
  const state = { 'grpc:1': { response: { payload: { match: { matchId: '5', name: 'A - B', matchDateUtc: '2026-11-18T00:30:00Z', subCategories: [{ markets: [
    { id: 'm1', name: 'Total de pontos do Jogador', selectionMatrix: [{ selections: [sel('Og Anunoby Acima de 16,5', 1.83), sel('Og Anunoby Abaixo de 16,5', 1.85)] }] },
    { id: 'm2', name: 'Total de Pontos', groupMarkets: [{ name: 'Og Anunoby', sliderValues: [{ value: 9.5, selections: [sel('Acima de 9,5', 1.07)] }, { value: 14.5, selections: [sel('Acima de 14,5', 1.49)] }] }] },
    { id: 'm3', name: 'Toronto Raptors - Total de pontos', selectionMatrix: [{ selections: [sel('Acima de 110,5', 1.8), sel('Abaixo de 110,5', 1.9)] }] },
  ] }] } } } } };
  const b = B.parseBetclicEvent(state);
  const p = b.players[B.normName('OG Anunoby')];
  assert.deepStrictEqual(p.markets.pts.lines, [{ line: 16.5, over: 1.83, under: 1.85 }]);
  assert.deepStrictEqual(p.markets.pts.ladder, [{ k: 10, dec: 1.07 }, { k: 15, dec: 1.49 }]);
  assert.strictEqual(Object.keys(b.players).length, 1);
  const lg = B.parseBetclicLeague({ 'grpc:2': { response: { payload: { matches: [{ matchId: '12', name: 'Toronto Raptors - New York Knicks', matchDateUtc: '2026-11-18T00:30:00Z' }] } } } });
  assert.strictEqual(lg[0].path, '/basquetebol-sbasketball/nba-c13/toronto-raptors-new-york-knicks-m12');
});

test('games and players match across books by nickname and name', () => {
  const g = { home: { name: 'LA Clippers' }, away: { name: 'Portland Trail Blazers' } };
  assert.ok(B.matchGame(g, [{ name: 'Los Angeles Clippers - Portland Trail Blazers' }]));
  assert.strictEqual(B.matchGame(g, [{ name: 'Utah Jazz - Portland Trail Blazers' }]), null);
  const book = { players: { [B.normName('Nikola Jokić')]: { name: 'Nikola Jokić' }, [B.normName('Herb Jones')]: { name: 'Herb Jones' }, x: { name: 'Nobody Here' } } };
  const m = B.matchPlayers(book, [{ id: '1', name: 'Nikola Jokic' }, { id: '2', name: 'Herbert Jones' }]);
  assert.deepStrictEqual(Object.keys(m).sort(), ['1', '2']);
});

/* ------------------------------------------------------------- pricing */

test('price: DraftKings anchors, the over correction applies, every book gets EV', () => {
  const P = B.params({ overShift: { pts: 0.03 }, weight: { pts: 0 }, disp: { pts: [3, 0] } });
  const dk = { lines: [{ line: 20.5, over: 1.909, under: 1.909 }], ladder: [] };
  const bn = { lines: [{ line: 21.5, over: 1.8, under: 2.1 }], ladder: [{ k: 25, dec: 4 }] };
  const pr = B.price({ m: 'pts', books: [{ book: 'DraftKings', mk: dk }, { book: 'Betano', mk: bn }], muModel: 30, P });
  near(pr.anchor.pOverRaw, 0.5, 1e-9);
  near(pr.anchor.pOver, 0.47, 1e-9);
  near(pr.dist.line(20.5).over, 0.47, 1e-3); // weight 0: the model's 30 does not move it
  const under = pr.bets.find((b) => b.book === 'Betano' && b.side === 'under');
  near(under.ev, pr.dist.line(21.5).under * 2.1 - 1, 1e-9);
  assert.ok(under.ev > 0);
  const lad = pr.bets.find((b) => b.side === 'atleast');
  near(lad.p, pr.dist.atLeast(25), 1e-12);
});

test('price: a bet priced far below our chance is suspect, a far rung is untested', () => {
  const P = B.params({ overShift: { reb: 0 }, disp: { reb: [1.2, 0] } });
  const dk = { lines: [{ line: 10.5, over: 1.9, under: 1.9 }], ladder: [{ k: 7, dec: 12 }, { k: 20, dec: 40 }] };
  const pr = B.price({ m: 'reb', books: [{ book: 'DraftKings', mk: dk }], muModel: null, P });
  assert.ok(pr.bets.find((b) => b.line === 7).suspect);
  assert.ok(pr.bets.find((b) => b.line === 20).far);
  assert.ok(!pr.bets.find((b) => b.side === 'over').far);
});

test('buildBoard: one line per player and stat, picks ranked by EV, no suspect or far ones', () => {
  const rows = Array.from({ length: 8 }, (_, i) => row({ date: '2026-11-0' + (i + 1), team: '10', pts: 20 + i }));
  const night = {
    date: '2026-11-17', out: [],
    players: { 7: { id: '7', name: 'Some Guard', grp: 'G', rows, prev: [] } },
    games: [{
      id: 'g', start: 0, home: { id: '10', ab: 'HOM', name: 'Home Hawks' }, away: { id: '20', ab: 'AWY', name: 'Away Owls' },
      total: 225, spread: -3, b2b: { home: false, away: false },
      books: {
        DraftKings: { players: { 7: { markets: { pts: { lines: [{ line: 22.5, over: 1.91, under: 1.91 }], ladder: [{ k: 10, dec: 30 }] } } } } },
        Betano: { players: { [B.normName('Some Guard')]: { name: 'Some Guard', markets: { pts: { lines: [{ line: 23.5, over: 1.75, under: 2.2 }], ladder: [] } } } } },
      },
    }],
  };
  const board = B.buildBoard(night, null);
  assert.strictEqual(board.lines.length, 1);
  const L = board.lines[0];
  assert.strictEqual(L.ctx.team, 'HOM');
  assert.strictEqual(L.ctx.opp, 'AWY');
  assert.strictEqual(L.ctx.spread, -3);
  assert.ok(board.picks.every((p, i) => i === 0 || board.picks[i - 1].ev >= p.ev));
  assert.ok(board.picks.every((p) => !p.suspect && !p.far));
  assert.ok(board.picks.some((p) => p.book === 'Betano' && p.side === 'under'));
});

test('analysis: hit rates against the line and splits without an injured teammate', () => {
  const rows = [10, 30, 30, 30, 10, 10].map((pts, i) => row({ pts, date: '2026-11-0' + (i + 1), opp: i === 5 ? 'BOS' : 'NY' }));
  const mateRows = [1, 5, 6].map((i) => row({ date: '2026-11-0' + i }));
  const a = B.analysis({ rows, prevRows: [], m: 'pts', line: 20.5, ctx: { opp: 'BOS' }, F: null, grp: 'G', mates: [{ name: 'Star', rows: mateRows }] });
  assert.deepStrictEqual([a.last5.over, a.last5.under, a.season.over], [3, 2, 3]);
  assert.strictEqual(a.vsOpp.n, 1);
  assert.strictEqual(a.without.length, 1);
  assert.strictEqual(a.without[0].n, 3); // days 2, 3, 4
  near(a.without[0].avg, 30);
  near(a.without[0].avgWith, 10);
});
