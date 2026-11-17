(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WPInsights = api; // also when a host page (e.g. ESPN) has its own global `module`
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  /* ------------------------------------------------------------- plumbing */

  let _M = null;
  function model() {
    if (_M) return _M;
    if (root && root.WPModel) _M = root.WPModel;
    else if (typeof require === 'function') _M = require('./model.js');
    if (!_M) throw new Error('WPInsights needs WPModel (load model.js first).');
    return _M;
  }

  const EPS = 1e-7;
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const isOutP = (p) => model().OUT_STATUSES.indexOf(p.injury) >= 0;
  const rosterArr = (r) => (Array.isArray(r) ? r : (r && r.current) || []);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Box-Muller, two normals per pair of uniforms.
  function makeNormal(rng) {
    let spare = null;
    return function () {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = rng();
      while (u <= 1e-12) u = rng();
      const w = rng();
      const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * w;
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    };
  }

  // Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7).
  function normCdf(x) {
    const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return 0.5 * (1 + s * (1 - poly * Math.exp(-z * z)));
  }

  /* ----------------------------------------------------- win probability */

  // miss: chance a starter sits without warning. His points are scaled up by the same amount, so the
  // team's expected score (the projected finish) does not change, only how far it can swing.
  function simTeam(tw, factors, dtdPlay, miss) {
    const b2bPlay = factors && factors.b2bPlay > 0 ? factors.b2bPlay : 1;
    const backPlay = model().BACK_PLAY;
    const list = [];
    ((tw && tw.rows) || []).forEach((r, who) => {
      const cells = r.cells || {};
      Object.keys(cells).forEach((k) => {
        const c = cells[k];
        if (!c || c.t !== 'proj' || !c.start || c.out) return;
        // chances of playing that the expected points already allow for: back-to-backs, a return from injury
        const bp = (c.b2b && factors ? b2bPlay : 1) * (c.back ? backPlay : 1);
        const q = bp * (c.dtd ? dtdPlay : 1) * (1 - miss);
        const x = (isNum(c.fp) ? c.fp : 0) / (bp * (1 - miss));
        list.push({ q, x, who });
      });
    });
    return { base: (tw && isNum(tw.actual) ? tw.actual : 0), list };
  }

  function winProbability(vm, opts) {
    opts = opts || {};
    const factors = opts.factors || null;
    const sims = Math.max(1, Math.floor(opts.sims != null ? opts.sims : 5000));
    // Defaults fitted with tools/backtest.js on 2025-26 and checked on 2024-25.
    const cv = opts.cv != null ? opts.cv : 0.4;
    const miss = opts.miss != null ? opts.miss : 0.1;
    const levelSd = opts.levelSd != null ? opts.levelSd : 0.25; // how wrong a player's level can be, shared by all his games
    const dtdPlay = opts.dtdPlay != null ? opts.dtdPlay : 0.75;
    const rng = mulberry32(opts.seed != null ? opts.seed : 1);
    const norm = makeNormal(rng);
    const A = simTeam(vm.me, factors, dtdPlay, miss);
    const B = vm.opp ? simTeam(vm.opp, factors, dtdPlay, miss) : null;

    const one = (T) => {
      let s = T.base;
      const level = [];
      for (let i = 0; i < T.list.length; i++) {
        const e = T.list[i];
        if (level[e.who] === undefined) level[e.who] = 1 + levelSd * norm();
        if (e.q >= 1 || rng() < e.q) { const v = e.x * level[e.who] * (1 + cv * norm()); if (v > 0) s += v; }
      }
      return s;
    };

    // Welford running mean / variance (exactly zero spread when nothing is left to play)
    const acc = () => ({ n: 0, mean: 0, m2: 0 });
    const push = (w, x) => { w.n++; const d = x - w.mean; w.mean += d / w.n; w.m2 += d * (x - w.mean); };
    const fin = (w) => ({ mean: w.mean, sd: Math.sqrt(w.m2 / w.n) });
    let wins = 0, ties = 0;
    const wa = acc(), wb = acc();
    for (let i = 0; i < sims; i++) {
      const a = one(A);
      push(wa, a);
      if (B) {
        const b = one(B);
        push(wb, b);
        if (a > b) wins++; else if (a === b) ties++;
      }
    }
    if (!B) return { pWin: null, pTie: null, me: fin(wa), opp: null };
    return { pWin: (wins + 0.5 * ties) / sims, pTie: ties / sims, me: fin(wa), opp: fin(wb) };
  }

  function winDelta(wp, gain) {
    if (!wp || !wp.opp || !wp.me) return null;
    const s = Math.sqrt(wp.me.sd * wp.me.sd + wp.opp.sd * wp.opp.sd);
    const d = wp.me.mean - wp.opp.mean;
    gain = gain || 0;
    if (!(s > 0)) {
      const f = (x) => (x > 0 ? 1 : x < 0 ? 0 : 0.5);
      return f(d + gain) - f(d);
    }
    return normCdf((d + gain) / s) - normCdf(d / s);
  }

  /* ------------------------------------------------- shared value engine */

  // Lean twin of WPModel.bestLineup that only returns the lineup total: same greedy-by-weight
  // augmenting-path matching, but no per-call allocation (trade search needs ~10^5 of these).
  // Cross-checked against WPModel.bestLineup in the tests.
  function makeSolver(caps) {
    const inst = [];
    Object.keys(caps).forEach((k) => {
      const s = +k;
      if (s === 12 || s === 13) return;
      for (let i = 0; i < caps[k]; i++) inst.push(s);
    });
    const N = inst.length;
    const owner = new Int32Array(N), seen = new Uint8Array(N);
    const sw = [], sa = [], ord = [];
    let m = 0;
    function aug(ci) {
      const a = sa[ci];
      for (let t = 0; t < a.length; t++) {
        const j = a[t];
        if (seen[j]) continue;
        seen[j] = 1;
        if (owner[j] < 0 || aug(owner[j])) { owner[j] = ci; return true; }
      }
      return false;
    }
    return {
      adj(slots) {
        const a = [];
        for (let j = 0; j < N; j++) if (slots.indexOf(inst[j]) >= 0) a.push(j);
        return a;
      },
      reset() { m = 0; },
      push(w, adj) { sw[m] = w; sa[m] = adj; m++; },
      total() {
        if (!m || !N) return 0;
        for (let i = 0; i < m; i++) { // insertion sort, weight descending, input order on ties
          let k = i;
          while (k > 0 && sw[ord[k - 1]] < sw[i]) { ord[k] = ord[k - 1]; k--; }
          ord[k] = i;
        }
        owner.fill(-1);
        let filled = 0;
        for (let o = 0; o < m && filled < N; o++) {
          const ci = ord[o];
          if (!sa[ci].length) continue;
          seen.fill(0);
          if (aug(ci)) filled++;
        }
        let t = 0;
        for (let j = 0; j < N; j++) if (owner[j] >= 0) t += sw[owner[j]];
        return t;
      },
    };
  }

  // One "run" fixes the league, schedule, factors and day range, and caches projections and
  // per-team game multipliers so every roster evaluation in a call reuses them.
  function makeRun(args, fromSp, toSp) {
    const M = model();
    const league = args.league, sched = args.sched;
    const isPoints = league.isPoints !== false;
    const F = isPoints ? (args.factors || null) : null;
    const from = fromSp != null ? fromSp : league.currentSp;
    let to = toSp != null ? toSp : from + 27;
    if (isNum(league.finalSp) && to > league.finalSp) to = league.finalSp;
    const n = Math.max(0, to - from + 1);
    const caps = league.caps || {};
    const fpCache = new Map(), tvCache = new Map(), entCache = new Map();
    const solver = makeSolver(caps);

    function fpOf(p) {
      let v = fpCache.get(p);
      if (v === undefined) { v = M.projectPlayer(p, league.season, isPoints).fp; fpCache.set(p, v); }
      return v;
    }
    // per-day expected-points multiplier for a pro team, -1 when it has no game
    function tv(proId) {
      let v = tvCache.get(proId);
      if (!v) {
        v = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const sp = from + i;
          v[i] = M.teamGame(sched, proId, sp) ? M.gameMult(sched, F, proId, sp).mult : -1;
        }
        tvCache.set(proId, v);
      }
      return v;
    }
    // Share of games he can be expected to play (WPModel.availability). args.availability === false turns it off.
    const useAvail = isPoints && args.availability !== false;
    const tgCache = new Map();
    function availOf(p) {
      if (!useAvail) return 1;
      let tg = tgCache.get(p.proTeamId);
      if (tg === undefined) { tg = M.teamGamesBefore(sched, p.proTeamId, league.currentSp); tgCache.set(p.proTeamId, tg); }
      return M.availability(p, league.season, tg);
    }
    // fp = points per game (ranks players); w = the same times his availability (what a game is worth);
    // first = first day of the run he can play: an out player counts from his expected return, if the
    // injury report gives one, and a player parked in an IR slot without being out never does.
    function ent(p) {
      let e = entCache.get(p);
      if (!e) {
        const ir = p.slot === 13, out = isOutP(p), fp = fpOf(p);
        const first = out ? (p.back && isNum(p.back.sp) ? Math.max(0, p.back.sp - from) : Infinity) : ir ? Infinity : 0;
        e = { p, fp, w: fp * availOf(p), tv: tv(p.proTeamId), adj: solver.adj(p.eligible || []), ir, out, first, active: first < n };
        entCache.set(p, e);
      }
      return e;
    }
    // Σ over days of the best lineup
    function valueOver(ents) {
      let total = 0;
      for (let d = 0; d < n; d++) {
        solver.reset();
        for (let i = 0; i < ents.length; i++) { const e = ents[i]; if (d >= e.first && e.tv[d] >= 0) solver.push(e.w * e.tv[d], e.adj); }
        total += solver.total();
      }
      return total;
    }
    const perWeek = (total) => (n ? total / n * 7 : 0);
    return { M, league, sched, F, from, to, n, caps, solver, fpOf, tv, ent, valueOver, perWeek };
  }

  function rosValue(args) {
    const run = makeRun(args, args.fromSp, args.toSp);
    const total = run.valueOver(rosterArr(args.roster).map(run.ent));
    return { total, perWeek: run.perWeek(total), days: run.n };
  }

  /* ------------------------------------------------------------- trades */

  const cmpId = (a, b) => (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0);
  // The lowest-projected non-IR players are dropped until the roster fits. Out players fill any free IR slots first.
  function forcedDrops(post, limit, irCount) {
    const pool = post.filter((e) => !e.ir);
    pool.sort((a, b) => (a.fp - b.fp) || cmpId(a, b));
    let free = (irCount || 0) - (post.length - pool.length);
    for (let i = pool.length - 1; i >= 0 && free > 0; i--) {
      if (model().irEligible(pool[i].p)) { pool.splice(i, 1); free--; }
    }
    const over = pool.length - limit;
    return over > 0 ? pool.slice(0, over) : [];
  }
  const rosterLimit = (league) => (league.starters || 0) + (league.benchCount || 0);

  function pickPlayers(roster, ids) {
    const want = new Set((ids || []).map(String));
    return roster.filter((p) => want.has(String(p.id)));
  }

  function analyzeTrade(args) {
    const league = args.league;
    const run = makeRun(args, args.fromSp, args.toSp);
    const rosters = args.rosters || {};
    const mine = rosterArr(rosters[args.myTeamId]), theirs = rosterArr(rosters[args.otherTeamId]);
    const giveP = pickPlayers(mine, args.give), getP = pickPlayers(theirs, args.get);
    const limit = rosterLimit(league);
    function side(roster, out, inn) {
      const before = run.perWeek(run.valueOver(roster.map(run.ent)));
      const outSet = new Set(out);
      const post = roster.filter((p) => !outSet.has(p)).concat(inn).map(run.ent);
      const drops = forcedDrops(post, limit, league.irCount);
      const dropSet = new Set(drops);
      const after = run.perWeek(run.valueOver(post.filter((e) => !dropSet.has(e))));
      return { v: { before, after, delta: after - before }, drops: drops.map((e) => e.p) };
    }
    const a = side(mine, giveP, getP), b = side(theirs, getP, giveP);
    return {
      me: a.v, them: b.v,
      drops: { me: a.drops[0] || null, them: b.drops[0] || null },
      allDrops: { me: a.drops, them: b.drops },
    };
  }

  // Both rosters of one possible trade partner, with per-day lineup values memoised on the set of
  // moved players that actually have a game that day, so thousands of trades share few lineups.
  function makeSpace(run, myRoster, otherRoster) {
    const n = run.n, solver = run.solver, limit = rosterLimit(run.league);
    let idx = 0;
    const mk = (p) => {
      const e = Object.assign({}, run.ent(p));
      e.bit = Math.pow(2, idx++);
      e.play = new Uint8Array(n);
      for (let d = 0; d < n; d++) e.play[d] = d >= e.first && e.tv[d] >= 0 ? 1 : 0;
      return e;
    };
    function mkSide(roster) {
      const ents = roster.map(mk);
      const base = new Float64Array(n);
      let baseTotal = 0, nonIr = 0;
      for (let d = 0; d < n; d++) {
        solver.reset();
        for (let i = 0; i < ents.length; i++) if (ents[i].play[d]) solver.push(ents[i].w * ents[i].tv[d], ents[i].adj);
        base[d] = solver.total();
        baseTotal += base[d];
      }
      ents.forEach((e) => { if (!e.ir) nonIr++; });
      const memo = [];
      for (let d = 0; d < n; d++) memo.push(new Map());
      return { ents, base, baseTotal, nonIr, memo };
    }
    const me = mkSide(myRoster), them = mkSide(otherRoster);

    function dropsFor(S, out, inn) {
      let cnt = S.nonIr;
      for (let i = 0; i < out.length; i++) if (!out[i].ir) cnt--;
      for (let i = 0; i < inn.length; i++) if (!inn[i].ir) cnt++;
      if (cnt <= limit) return [];
      return forcedDrops(S.ents.filter((e) => out.indexOf(e) < 0).concat(inn), limit, run.league.irCount);
    }
    function sideTotal(S, removed, added) {
      let total = 0;
      for (let d = 0; d < n; d++) {
        let mask = 0;
        for (let i = 0; i < removed.length; i++) if (removed[i].play[d]) mask += removed[i].bit;
        for (let i = 0; i < added.length; i++) if (added[i].play[d]) mask += added[i].bit;
        if (mask === 0) { total += S.base[d]; continue; }
        let v = S.memo[d].get(mask);
        if (v === undefined) {
          solver.reset();
          for (let i = 0; i < S.ents.length; i++) {
            const e = S.ents[i];
            if (e.play[d] && removed.indexOf(e) < 0) solver.push(e.w * e.tv[d], e.adj);
          }
          for (let i = 0; i < added.length; i++) if (added[i].play[d]) solver.push(added[i].w * added[i].tv[d], added[i].adj);
          v = solver.total();
          S.memo[d].set(mask, v);
        }
        total += v;
      }
      return total;
    }
    const gainOf = (S, total) => (n ? (total - S.baseTotal) / n * 7 : 0);
    // players leaving S (sent away or dropped) and arriving at S (minus any dropped on arrival)
    function gainFor(S, out, inn) {
      const drops = dropsFor(S, out, inn);
      if (drops.length) {
        out = out.concat(drops.filter((e) => inn.indexOf(e) < 0));
        inn = inn.filter((e) => drops.indexOf(e) < 0);
      }
      return gainOf(S, sideTotal(S, out, inn));
    }
    // null unless both sides gain
    function evaluate(giveE, getE) {
      const myGain = gainFor(me, giveE, getE);
      if (!(myGain > EPS)) return null;
      const theirGain = gainFor(them, getE, giveE);
      if (!(theirGain > EPS)) return null;
      return { myGain, theirGain };
    }
    return { me, them, evaluate };
  }

  function tradeIdeas(args) {
    const league = args.league;
    const horizon = args.horizonDays > 0 ? args.horizonDays : 28;
    const limit = args.limit != null ? args.limit : 20;
    const from = args.fromSp != null ? args.fromSp : league.currentSp;
    const run = makeRun(args, from, from + horizon - 1);
    const rosters = args.rosters || {};
    const mine = rosterArr(rosters[args.myTeamId]);
    const TOP = 10;
    const top = (ents) => ents.filter((e) => e.active).sort((a, b) => (b.fp - a.fp) || cmpId(a, b)).slice(0, TOP);
    const found = [];

    Object.keys(rosters).forEach((k) => {
      if (String(k) === String(args.myTeamId)) return;
      const teamId = isNum(+k) ? +k : k;
      const space = makeSpace(run, mine, rosterArr(rosters[k]));
      const cm = top(space.me.ents), ct = top(space.them.ents);
      const add = (give, get) => {
        const r = space.evaluate(give, get);
        if (r) found.push({ teamId, give: give.map((e) => e.p), get: get.map((e) => e.p), myGain: r.myGain, theirGain: r.theirGain });
      };
      for (let i = 0; i < cm.length; i++) {
        for (let j = 0; j < ct.length; j++) add([cm[i]], [ct[j]]); // 1-for-1
      }
      // 2-for-1 (I give two, get one): the one I get out-projects both I give
      for (let i = 0; i < cm.length; i++) {
        for (let i2 = i + 1; i2 < cm.length; i2++) {
          for (let j = 0; j < ct.length; j++) {
            if (ct[j].fp > cm[i].fp && ct[j].fp > cm[i2].fp) add([cm[i], cm[i2]], [ct[j]]);
          }
        }
      }
      // 1-for-2 (I give one, get two): the one I give out-projects both I get
      for (let i = 0; i < cm.length; i++) {
        for (let j = 0; j < ct.length; j++) {
          for (let j2 = j + 1; j2 < ct.length; j2++) {
            if (cm[i].fp > ct[j].fp && cm[i].fp > ct[j2].fp) add([cm[i]], [ct[j], ct[j2]]);
          }
        }
      }
    });
    found.sort((a, b) => (Math.min(b.myGain, b.theirGain) - Math.min(a.myGain, a.theirGain)) ||
      ((b.myGain + b.theirGain) - (a.myGain + a.theirGain)));
    return found.slice(0, limit);
  }

  /* ------------------------------------------------------ power rankings */

  function powerRankings(args) {
    const league = args.league;
    const from = args.fromSp != null ? args.fromSp : league.currentSp;
    const run = makeRun(args, from, from + 27);
    const rosters = args.rosters || {};
    const matchups = args.matchups || league.matchups || [];
    const curMp = league.currentMp != null ? league.currentMp : 1;
    const regular = league.regularCount || 0;
    const ids = Object.keys(league.teams || {});
    Object.keys(rosters).forEach((k) => { if (ids.indexOf(String(k)) < 0) ids.push(String(k)); });

    const rows = ids.map((id) => {
      const t = (league.teams && league.teams[id]) || {};
      const strength = run.perWeek(run.valueOver(rosterArr(rosters[id]).map(run.ent)));
      let pf = 0;
      matchups.forEach((m) => {
        if (!(m.mp < curMp)) return;
        [m.home, m.away].forEach((s) => { if (s && String(s.teamId) === id && isNum(s.total)) pf += s.total; });
      });
      const rec = t.record || {};
      return {
        rank: 0, teamId: isNum(+id) ? +id : id, name: t.name || ('Team ' + id), abbrev: t.abbrev || '',
        record: { wins: rec.wins || 0, losses: rec.losses || 0, ties: rec.ties || 0 }, pf, strength, sos: null,
      };
    });
    const strengthOf = {};
    rows.forEach((r) => { strengthOf[r.teamId] = r.strength; });
    rows.forEach((r) => {
      const opps = [];
      matchups.forEach((m) => {
        if (!(m.mp >= curMp && m.mp <= regular) || !m.home || !m.away) return;
        if (m.home.teamId === r.teamId && strengthOf[m.away.teamId] !== undefined) opps.push(strengthOf[m.away.teamId]);
        else if (m.away.teamId === r.teamId && strengthOf[m.home.teamId] !== undefined) opps.push(strengthOf[m.home.teamId]);
      });
      r.sos = opps.length ? opps.reduce((a, b) => a + b, 0) / opps.length : null;
    });
    rows.sort((a, b) => (b.strength - a.strength) || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  /* ----------------------------------------------------- playoff planner */

  function playoffPlanner(args) {
    const M = model();
    const league = args.league, sched = args.sched;
    const isPoints = league.isPoints !== false;
    const F = isPoints ? (args.factors || null) : null;
    const season = league.season;
    const weeks = (args.weeks || []).filter((w) => w.playoff);
    const cache = new Map();
    function plan(proId) {
      let t = cache.get(proId);
      if (t) return t;
      t = { games: {}, total: 0, b2b: 0, sumMult: 0 };
      weeks.forEach((w) => {
        let c = 0;
        w.sps.forEach((sp) => {
          if (!M.teamGame(sched, proId, sp)) return;
          c++;
          if (M.teamGame(sched, proId, sp - 1)) t.b2b++;
          t.sumMult += M.gameMult(sched, F, proId, sp).mult;
        });
        t.games[w.id] = c;
        t.total += c;
      });
      cache.set(proId, t);
      return t;
    }
    const teams = Object.keys(sched.teams || {}).map((k) => {
      const st = sched.teams[k], p = plan(st.id);
      return { proId: st.id, abbrev: st.abbrev, games: Object.assign({}, p.games), total: p.total, b2b: p.b2b };
    });
    teams.sort((a, b) => (b.total - a.total) || (a.abbrev < b.abbrev ? -1 : a.abbrev > b.abbrev ? 1 : 0));
    const row = (p) => {
      const t = plan(p.proTeamId), proj = M.projectPlayer(p, season, isPoints);
      return { player: p, proj, games: Object.assign({}, t.games), total: t.total, expFp: proj.fp * t.sumMult };
    };
    const byExp = (a, b) => (b.expFp - a.expFp) || (a.player.name < b.player.name ? -1 : a.player.name > b.player.name ? 1 : 0);
    const mine = rosterArr(args.roster).map(row).sort(byExp);
    const fas = (args.freeAgents || []).filter((p) => !isOutP(p)).map(row).sort(byExp).slice(0, 25);
    return { weeks: weeks.map((w) => ({ id: w.id, label: w.label, range: w.range })), teams, mine, fas };
  }

  /* -------------------------------------------------------------- trends */

  function findStat(p, id) {
    const st = (p && p.stats) || [];
    for (let i = 0; i < st.length; i++) if (st[i] && String(st[i].id) === id) return st[i];
    return null;
  }
  const gpOf = (e) => (e && e.stats && isNum(e.stats[42]) && e.stats[42] > 0 ? e.stats[42] : 0);
  function avgOf(e) {
    if (!e) return null;
    if (e.appliedAverage) return e.appliedAverage;
    const g = gpOf(e);
    return g && isNum(e.appliedTotal) ? e.appliedTotal / g : null;
  }
  function perGame(e, statId) {
    const g = gpOf(e);
    return g && isNum(e.stats[statId]) ? e.stats[statId] / g : null;
  }

  function trends(players, season) {
    return (players || []).map((player) => {
      const cur = findStat(player, '00' + season), e7 = findStat(player, '01' + season);
      const e15 = findStat(player, '02' + season), pj = findStat(player, '10' + season);
      const avg = avgOf(cur), l7 = avgOf(e7), l15 = avgOf(e15), proj = avgOf(pj);
      const n = gpOf(cur), n15 = gpOf(e15);
      const mpg = perGame(cur, 40), mpgL15 = perGame(e15, 40);
      const startRate = perGame(cur, 41), startRateL15 = perGame(e15, 41);
      const base = proj != null ? proj : avg;
      const delta = isNum(l15) && isNum(base) ? l15 - base : null;
      let tag = null;
      if (n15 >= 3 && delta !== null) {
        if (l15 >= 1.15 * base && l15 - base >= 3) tag = 'rising';
        else if (l15 <= 0.85 * base && base - l15 >= 3) tag = 'falling';
      }
      let role = null;
      if (startRate !== null && startRateL15 !== null && startRate < 0.5 && startRateL15 >= 0.6) role = 'new starter';
      else if (startRate !== null && startRateL15 !== null && startRate >= 0.6 && startRateL15 < 0.4) role = 'lost start';
      else if (mpg !== null && mpgL15 !== null && mpgL15 - mpg >= 4) role = 'more minutes';
      else if (mpg !== null && mpgL15 !== null && mpgL15 - mpg <= -4) role = 'fewer minutes';
      return { player, avg, n, l7, l15, n15, proj, mpg, mpgL15, startRate, startRateL15, delta, tag, role };
    });
  }

  function buyLowSellHigh(rows, myTeamId) {
    const base = (r) => (isNum(r.proj) ? r.proj : r.avg);
    const mine = (r) => r.player.onTeamId != null && String(r.player.onTeamId) === String(myTeamId);
    const buyLow = (rows || [])
      .filter((r) => r.player.onTeamId != null && !mine(r) && r.tag === 'falling' && isNum(base(r)) && base(r) >= 25)
      .sort((a, b) => a.delta - b.delta).slice(0, 15);
    const sellHigh = (rows || []).filter((r) => mine(r) && r.tag === 'rising').sort((a, b) => b.delta - a.delta);
    return { buyLow, sellHigh };
  }

  /* -------------------------------------------------------------- digest */

  const INJURY_LABEL = { OUT: 'OUT', INJURY_RESERVE: 'IR', SUSPENSION: 'suspended', DAY_TO_DAY: 'DTD' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // ESPN's expected return for an out player, as text: ', back around Nov 24' / ', out for the season' / ''
  function backText(p) {
    if (!p || !p.back || !isOutP(p)) return '';
    if (p.back.season) return ', out for the season';
    const d = p.back.date || '';
    return /^\d{4}-\d{2}-\d{2}/.test(d) ? ', back around ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10)) : '';
  }

  function pctText(p) {
    let v = Math.round(p * 100);
    if (v >= 100 && p < 1) v = 99;
    if (v <= 0 && p > 0) v = 1;
    return v + '%';
  }

  // ', enter it before Tue 08:00' in the local time zone of whoever runs the digest
  function claimBy(fa) {
    const ms = fa && fa.waiverDate;
    if (!isNum(ms)) return '';
    try {
      return ', enter it before ' + new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms) + ' ' +
        new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(ms);
    } catch (e) { return ''; }
  }

  function digest(args) {
    const vm = args.vm || {}, wp = args.wp || null, trendRows = args.trendRows || [];
    const me = vm.me || {}, opp = vm.opp || null, wk = vm.week || {};
    let today = args.today;
    if (today == null) {
      const d = (vm.days || []).find((x) => x.kind === 'today');
      today = d ? d.sp : null;
    }
    const f1 = (v) => (isNum(v) ? v.toFixed(1) : '0.0');
    const lines = [];
    const when = [wk.label, wk.range].filter(Boolean).join(' · ');
    lines.push((when ? when + ': ' : '') + (me.name || 'You') + ' ' + f1(me.actual) +
      (opp ? ', ' + (opp.name || 'Opponent') + ' ' + f1(opp.actual) : ', bye week'));
    if (opp && isNum(me.projFinal) && isNum(opp.projFinal)) {
      lines.push('Projected final: ' + f1(me.projFinal) + ' to ' + f1(opp.projFinal));
    }
    if (wp) {
      lines.push(wp.pWin == null ? 'Win chance: no opponent this week' : 'Win chance: ' + pctText(wp.pWin));
    }

    const rows = (me.rows || []).filter((r) => !r.gone);
    const day = (vm.days || []).find((d) => d.sp === today);
    if (day) {
      const rostered = rows.filter((r) => r.player && r.player.slot !== 13 && !(r.player.claimFrom > today) && !(r.leaves <= today)); // roster on that day, pending claims applied
      const plays = rostered.filter((r) => {
        const c = r.cells && r.cells[today];
        return c && ((c.t === 'proj' && !c.out) || (c.t === 'played' && c.why !== 'away'));
      }).length;
      lines.push('Today: ' + plays + ' of ' + rostered.length + ' players play');
      const info = me.days && me.days[today];
      if (info && info.open != null) lines.push('Open lineup slots today: ' + info.open);
    }

    const hurt = rows.filter((r) => r.player && INJURY_LABEL[r.player.injury])
      .map((r) => r.player.name + ' (' + INJURY_LABEL[r.player.injury] + backText(r.player) + ')');
    lines.push('Injuries: ' + (hurt.length ? hurt.join(', ') : 'none'));

    const myIds = new Set(rows.map((r) => r.player.id));
    const roles = trendRows.filter((r) => r.role && r.player && myIds.has(r.player.id))
      .map((r) => r.player.name + ' (' + r.role + ')');
    lines.push('Role changes: ' + (roles.length ? roles.join(', ') : 'none'));

    // With a week plan (WPModel.planWeek): today's move is the plan's, and a day without one shows what
    // is left once the whole plan is made. Without a plan, the day's own best add as before.
    const plan = args.plan && args.plan.moves ? args.plan : null;
    const planMove = plan ? plan.moves.find((m) => m.sp === today) || null : null;
    const left = plan && plan.vm ? plan.vm : vm;
    const rec = planMove || (left.recs && left.recs.byDay && left.recs.byDay[today] && left.recs.byDay[today][0]);
    const claimToday = vm.recs && vm.recs.claimDays && vm.recs.claimDays[today];
    if (claimToday && claimToday.length) lines.push('Claim day: ' + claimToday.map((x) => x.name).join(', ') + ' joins your roster today');
    if (rec && rec.fa) {
      const abbrevOf = (id) => {
        const gs = vm.gamesPerTeam || [];
        for (let i = 0; i < gs.length; i++) {
          const t = (gs[i].teams || []).find((x) => x.id === id);
          if (t) return t.abbrev;
        }
        return '';
      };
      const tag = [abbrevOf(rec.fa.proTeamId), rec.fa.pos].filter(Boolean).join(', ');
      const head = planMove ? 'In your plan today: ' : rec.worth === false ? 'Hold today. This week only: ' : rec.spend ? 'Spend your add today: ' : 'Best add today: ';
      let s = head + (rec.activate ? 'activate ' : '') + rec.fa.name + (rec.activate ? ' from IR' : tag ? ' (' + tag + ')' : '') +
        (rec.drop ? ', drop ' + rec.drop.name : rec.irMove ? ', move ' + rec.irMove.name + ' to IR, no drop' : ', no drop needed') + ', +' + f1(rec.gain) + ' FP this week';
      const dw = winDelta(wp, rec.gain);
      if (dw !== null && Math.abs(dw) >= 0.005) s += ', ' + (dw > 0 ? '+' : '-') + Math.round(Math.abs(dw) * 100) + '% win chance';
      if (isNum(rec.longTerm)) s += ', ' + (rec.longTerm >= 0 ? '+' : '') + f1(rec.longTerm) + ' FP over the next ' + (rec.ltWeeks || 3) + ' weeks';
      if (rec.waiver) s += ' (waiver claim)';
      lines.push(s);
      const sp = vm.recs && vm.recs.spend;
      if (!plan && sp && sp !== rec && sp.fa) {
        const day = (vm.days || []).find((x) => x.sp === sp.sp);
        lines.push('Best night for an add this week: ' + (day ? day.dow : 'sp ' + sp.sp) + ', ' + sp.fa.name + (sp.drop ? ' for ' + sp.drop.name : sp.irMove ? ', moving ' + sp.irMove.name + ' to IR' : '') + ', total ' + (sp.net >= 0 ? '+' : '') + f1(sp.net) + ' FP' + (sp.waiver ? ' (waiver claim, processes that morning)' : ''));
      }
    } else {
      const note = vm.recs && vm.recs.note;
      lines.push('No add worth it today' + (note ? ' (' + note + ')' : ''));
    }
    if (plan && plan.moves.length) {
      const dayOf = (sp) => { const d = (vm.days || []).find((x) => x.sp === sp); return d && d.dow ? d.dow : 'day ' + sp; };
      const sgn = (v) => (v >= 0 ? '+' : '') + f1(v);
      lines.push('Plan for the week: ' + plan.moves.map((m) => dayOf(m.sp) + ' ' + (m.activate ? 'activate ' : '') + m.fa.name + (m.activate ? ' from IR' : '') +
        (m.drop ? (m.activate ? ', drop ' : ' for ') + m.drop.name : m.irMove ? ' (move ' + m.irMove.name + ' to IR)' : '') + (m.waiver ? ' (waiver claim' + claimBy(m.fa) + ')' : '')).join('; ') +
        '. ' + sgn(plan.gain) + ' FP this week, ' + sgn(plan.longTerm) + ' over the next ' + ((plan.moves[0] && plan.moves[0].ltWeeks) || 3) + ' weeks');
    }
    return lines.join('\n');
  }

  return {
    winProbability, winDelta, playoffPlanner, trends, buyLowSellHigh, rosValue, backText,
    analyzeTrade, tradeIdeas, powerRankings, digest,
  };
});
