/* Fake ESPN responses for ?demo mode. Raw ESPN-shaped JSON (SPEC "ESPN API facts").
   Everything is generated deterministically in code; nothing here is real league data.
   Scenario: Thu 2026-10-29 20:30 ET, week 2 (sp 7-13), "Thanos was right" (6) vs "Lebrontocracy" (4).
   Opponents in other weeks reuse the Lebrontocracy roster (demo shortcut).
   League-wide requests (mRoster without rosterForTeamId, mMatchup without a team filter) are answered for all 16 teams:
   teams 6 and 4 are the same players as above, the other 14 rosters are generated from the seeded PRNG. */
(function (root) {
  'use strict';

  const SEASON = 2027, LEAGUE = 1257343892, ME = 6, OPP = 4, CUR = 10, FINAL = 174, SEED = 3;
  const NOW = Date.UTC(2026, 9, 30, 0, 30); // Thu 2026-10-29 20:30 EDT
  const CAL_TO_MP = (k) => (k <= 17 ? k : k <= 19 ? 18 : k === 20 ? 19 : k === 21 ? 20 : k <= 23 ? 21 : 22);

  const PRO = [[1, 'ATL', 'Atlanta', 'Hawks'], [2, 'BOS', 'Boston', 'Celtics'], [3, 'NOP', 'New Orleans', 'Pelicans'], [4, 'CHI', 'Chicago', 'Bulls'],
    [5, 'CLE', 'Cleveland', 'Cavaliers'], [6, 'DAL', 'Dallas', 'Mavericks'], [7, 'DEN', 'Denver', 'Nuggets'], [8, 'DET', 'Detroit', 'Pistons'],
    [9, 'GSW', 'Golden State', 'Warriors'], [10, 'HOU', 'Houston', 'Rockets'], [11, 'IND', 'Indiana', 'Pacers'], [12, 'LAC', 'LA', 'Clippers'],
    [13, 'LAL', 'Los Angeles', 'Lakers'], [14, 'MIA', 'Miami', 'Heat'], [15, 'MIL', 'Milwaukee', 'Bucks'], [16, 'MIN', 'Minnesota', 'Timberwolves'],
    [17, 'BKN', 'Brooklyn', 'Nets'], [18, 'NYK', 'New York', 'Knicks'], [19, 'ORL', 'Orlando', 'Magic'], [20, 'PHI', 'Philadelphia', '76ers'],
    [21, 'PHX', 'Phoenix', 'Suns'], [22, 'POR', 'Portland', 'Trail Blazers'], [23, 'SAC', 'Sacramento', 'Kings'], [24, 'SAS', 'San Antonio', 'Spurs'],
    [25, 'OKC', 'Oklahoma City', 'Thunder'], [26, 'UTA', 'Utah', 'Jazz'], [27, 'WAS', 'Washington', 'Wizards'], [28, 'TOR', 'Toronto', 'Raptors'],
    [29, 'MEM', 'Memphis', 'Grizzlies'], [30, 'CHA', 'Charlotte', 'Hornets']];
  const ID = {};
  PRO.forEach((t) => { ID[t[1]] = t[0]; });

  const FANTASY_TEAMS = ['Hoop Dreams', 'Splash Zone', 'Dunk Dynasty', 'Lebrontocracy', 'Triple Doubt', 'Thanos was right', 'Zero Dark Dirty', 'Pick and Roll Call',
    'Bucket Brigade', 'Fast Break Bad', 'The Process Server', 'Sixth Man Standing', 'Court Jesters', 'Air Ball Club', 'Rim Protectors', 'Garbage Time Heroes'];

  /* Rostered players: [id, name, pos, team, slot, pts, reb, ast, stl, blk, to, min, {from,to,inj}] (per-game averages) */
  const MINE = [
    [4278073, 'Shai Gilgeous-Alexander', 'PG/SG', 'OKC', 0, 31.5, 5.0, 6.2, 1.8, 1.0, 2.4, 34],
    [4594268, 'Anthony Edwards', 'SG', 'MIN', 1, 28.5, 5.5, 4.5, 1.3, 0.7, 3.0, 35],
    [4065648, 'Jayson Tatum', 'SF/PF', 'BOS', 2, 26.5, 8.5, 5.0, 1.1, 0.6, 2.7, 35],
    [3032977, 'Giannis Antetokounmpo', 'PF', 'MIL', 3, 29.0, 10.5, 5.8, 0.9, 1.0, 3.3, 33],
    [3112335, 'Nikola Jokic', 'C', 'DEN', 4, 25.5, 11.0, 8.0, 1.2, 0.6, 3.0, 34],
    [3934672, 'Jalen Brunson', 'PG', 'NYK', 5, 27.0, 3.5, 6.5, 0.9, 0.2, 2.5, 35],
    [4432158, 'Evan Mobley', 'PF/C', 'CLE', 6, 18.0, 9.5, 3.2, 1.0, 1.4, 1.8, 32, { inj: 'DAY_TO_DAY' }],
    [4871144, 'Alperen Sengun', 'C', 'HOU', 11, 20.0, 9.5, 5.5, 1.2, 0.8, 2.8, 32],
    [3907387, 'Desmond Bane', 'SG/SF', 'ORL', 11, 21.0, 4.5, 4.2, 1.1, 0.5, 2.0, 33],
    [3063111, 'Lauri Markkanen', 'PF', 'UTA', 11, 23.0, 6.5, 2.0, 0.7, 0.4, 1.7, 33],
    [4066336, 'Jarrett Allen', 'C', 'CLE', 12, 13.5, 9.5, 1.8, 0.7, 0.9, 1.4, 28],
    [4433134, 'Dyson Daniels', 'SG/SF', 'ATL', 12, 11.0, 5.5, 4.0, 2.4, 0.7, 1.8, 30, { from: 8 }],
    [4576060, "Day'Ron Sharpe", 'C', 'BKN', 12, 8.0, 7.5, 2.2, 0.8, 0.7, 1.5, 22, { from: 9 }],
    [3059318, 'Joel Embiid', 'C', 'PHI', 13, 25.0, 8.0, 3.5, 0.8, 1.0, 2.8, 31, { inj: 'OUT' }],
    [4683021, 'Scoot Henderson', 'PG', 'POR', 12, 12.0, 3.0, 5.0, 0.8, 0.2, 2.5, 25, { to: 7 }],
    [4712902, 'Isaiah Collier', 'PG', 'UTA', 12, 7.0, 3.0, 5.0, 0.9, 0.1, 2.0, 20, { to: 8 }],
  ].map((a) => ({ tid: ME, a }));
  const THEIRS = [
    [3945274, 'Luka Doncic', 'PG', 'LAL', 0, 30.0, 8.0, 7.5, 1.4, 0.4, 3.6, 35],
    [3136193, 'Devin Booker', 'SG', 'PHX', 1, 25.0, 4.0, 6.5, 0.9, 0.3, 2.8, 35],
    [3202, 'Kevin Durant', 'SF/PF', 'HOU', 2, 26.0, 5.5, 4.2, 0.9, 1.1, 3.0, 34],
    [1627783, 'Pascal Siakam', 'PF', 'IND', 3, 21.0, 6.5, 4.0, 0.9, 0.5, 2.4, 33],
    [5104157, 'Victor Wembanyama', 'C', 'SAS', 4, 25.0, 11.5, 3.5, 1.2, 3.3, 3.2, 33],
    [4433630, 'Cade Cunningham', 'PG', 'DET', 5, 25.0, 5.5, 8.5, 1.2, 0.4, 3.8, 35],
    [4432573, 'Paolo Banchero', 'PF', 'ORL', 6, 23.0, 7.5, 5.0, 0.9, 0.5, 3.2, 34],
    [4066648, 'LaMelo Ball', 'PG', 'CHA', 11, 26.0, 5.2, 7.5, 1.5, 0.4, 3.7, 33],
    [4594327, 'Jalen Williams', 'SF/SG', 'OKC', 11, 20.0, 5.0, 4.8, 1.3, 0.6, 2.2, 31],
    [3136195, 'Karl-Anthony Towns', 'C', 'NYK', 11, 21.0, 11.0, 3.0, 0.8, 0.6, 2.6, 33],
    [4277905, 'Trae Young', 'PG', 'WAS', 12, 21.0, 3.0, 10.0, 1.3, 0.2, 4.2, 33],
    [4066261, 'Bam Adebayo', 'C', 'MIA', 12, 17.0, 10.0, 3.5, 1.1, 0.8, 2.4, 32],
    [3917376, 'Jaylen Brown', 'SG/SF', 'BOS', 12, 22.0, 5.5, 3.5, 1.1, 0.4, 2.8, 33],
    [4396993, 'Tyrese Haliburton', 'PG', 'IND', 13, 18.0, 3.5, 9.0, 1.3, 0.5, 2.5, 32, { inj: 'OUT' }],
  ].map((a) => ({ tid: OPP, a }));

  /* Free agents: [name, pos, team, fp, %rostered, flag ('' | 'W' waivers | 'DTD' | 'OUT')] */
  const FAS = [
    ['Jock Landale', 'C', 'ATL', 21.5, 1.2, ''], ['Vit Krejci', 'SG/SF', 'ATL', 16.2, 2, ''], ['Payton Pritchard', 'PG/SG', 'BOS', 24.3, 61, ''],
    ['Sam Hauser', 'SF/PF', 'BOS', 15.9, 12, ''], ['Luka Garza', 'C', 'BOS', 14.8, 3, ''], ['Miles Bridges', 'SF/PF', 'CHA', 25.6, 55, ''],
    ['Moussa Diabate', 'C', 'CHA', 17.5, 4, ''], ['Tre Mann', 'PG', 'CHA', 15.2, 2, ''], ['Sam Merrill', 'SG', 'CLE', 16.9, 8, ''],
    ['Max Strus', 'SF', 'CLE', 17.4, 10, ''], ["Caris LeVert", 'SG/SF', 'CLE', 18.2, 14, 'DTD'], ['Moses Moody', 'SG/SF', 'GSW', 19.0, 27, ''],
    ['Brandin Podziemski', 'SG', 'GSW', 23.4, 49, 'W'], ['Gary Payton II', 'PG', 'GSW', 15.1, 4, ''], ['Jabari Smith Jr.', 'PF', 'HOU', 22.7, 58, ''],
    ['Tari Eason', 'PF', 'HOU', 21.6, 36, ''], ['Reed Sheppard', 'PG', 'HOU', 20.1, 31, ''], ['Steven Adams', 'C', 'HOU', 17.8, 9, ''],
    ['Bennedict Mathurin', 'SG/SF', 'IND', 22.0, 40, ''], ['Obi Toppin', 'PF', 'IND', 18.2, 17, ''], ['T.J. McConnell', 'PG', 'IND', 21.7, 35, ''],
    ['Rui Hachimura', 'PF', 'LAL', 20.3, 25, ''], ['Jaxson Hayes', 'C', 'LAL', 16.8, 6, ''], ['Dalton Knecht', 'SF', 'LAL', 15.6, 9, ''],
    ['Naz Reid', 'PF/C', 'MIN', 20.8, 52, ''], ['Donte DiVincenzo', 'SG', 'MIN', 18.8, 23, ''], ['Jaden McDaniels', 'SF', 'MIN', 20.4, 37, ''],
    ['Nick Richards', 'C', 'PHX', 18.6, 14, ''], ['Ayo Dosunmu', 'SG', 'CHI', 22.1, 25, ''], ['Coby White', 'PG', 'CHI', 23.1, 44, ''],
    ["Kel'el Ware", 'C', 'MIA', 24.5, 38, 'W'], ['Isaiah Hartenstein', 'C', 'OKC', 20.4, 41, ''], ['Cason Wallace', 'PG/SG', 'OKC', 19.5, 33, ''],
    ['Santi Aldama', 'PF', 'MEM', 19.2, 18, 'W'], ['Jaylen Wells', 'SF', 'MEM', 17.8, 22, ''], ['Zach Edey', 'C', 'MEM', 21.0, 28, 'W'],
    ['Quentin Grimes', 'SG', 'PHI', 19.9, 21, ''], ['Gradey Dick', 'SF', 'TOR', 16.4, 7, ''], ['Duncan Robinson', 'SG/SF', 'MIA', 18.1, 15, ''],
    ['Jonas Valanciunas', 'C', 'DEN', 15.8, 6, ''], ['Dereck Lively II', 'C', 'DAL', 19.4, 20, 'OUT'],
  ];

  const DNP = { 'Evan Mobley': [9], 'Paolo Banchero': [7], 'Devin Booker': [11] }; // sat out a game his team played
  const TARGET = { 7: { 6: 206.4, 4: 127 }, 8: { 6: 94, 4: 202.4 }, 9: { 6: 241, 4: 317.2 } };

  /* ------------------------------------------------------------------ helpers */

  function rng(a) { // mulberry32
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const shuffle = (arr, rnd) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };
  const r1 = (x) => Math.round(x * 10) / 10;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const hash01 = (id, k) => { const x = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const tenths = (b) => 10 * b.pts + 12 * b.reb + 15 * b.ast + 30 * b.stl + 30 * b.blk - 10 * b.to; // PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1

  function eligibleSlots(pos) {
    const s = pos.split('/'), set = new Set(s.map((p) => POS.indexOf(p)));
    const has = (...a) => a.some((x) => s.indexOf(x) >= 0);
    if (has('PG', 'SG')) set.add(5);
    if (has('SF', 'PF')) set.add(6);
    if (has('SG', 'SF')) set.add(7);
    if (has('PG', 'SG', 'SF', 'PF')) set.add(8);
    if (has('PF', 'C')) set.add(9);
    if (has('SF', 'PF', 'C')) set.add(10);
    return Array.from(set).sort((a, b) => a - b).concat([11, 12, 13]);
  }

  // US Eastern game time for a scoring period: minutes after midnight ET -> UTC ms
  function etMs(sp, minutes) {
    const d = new Date(Date.UTC(2026, 9, 20 + sp - 1));
    const iso = d.toISOString().slice(0, 10);
    const off = iso >= '2026-11-01' && iso < '2027-03-14' ? 5 : 4;
    return d.getTime() + (minutes / 60 + off) * 3600e3;
  }

  /* ------------------------------------------------------------- pro schedule */

  function planWeek2(rnd) { // sp 7..13 -> pro team ids; counts per team and per night as in SPEC
    const cap = { 7: 18, 8: 8, 9: 24, 10: 6, 11: 20, 12: 14, 13: 8 }, out = { 7: [], 8: [], 9: [], 10: [], 11: [], 12: [], 13: [] };
    const need = {};
    PRO.forEach((t) => { need[t[0]] = 3; });
    'ATL BOS CHA CLE GSW HOU IND LAL MIN'.split(' ').forEach((a) => { need[ID[a]] = 4; });
    need[ID.PHX] = 2;
    const pre = { 8: 'HOU IND SAS DET ORL CHA UTA TOR', 10: 'DEN LAL OKC ORL PHI MIL' };
    Object.keys(pre).forEach((sp) => pre[sp].split(' ').forEach((a) => { out[sp].push(ID[a]); need[ID[a]]--; cap[sp]--; }));
    const order = shuffle(Object.keys(need).map(Number), rnd).sort((a, b) => need[b] - need[a]); // shuffle + stable sort, never a random comparator
    for (const t of order) {
      const days = shuffle(Object.keys(cap).map(Number).filter((sp) => cap[sp] > 0 && out[sp].indexOf(t) < 0), rnd).sort((a, b) => cap[b] - cap[a]);
      if (days.length < need[t]) return null;
      days.slice(0, need[t]).forEach((sp) => { out[sp].push(t); cap[sp]--; });
    }
    return out;
  }

  let SCHED = null;
  function schedule() {
    if (SCHED) return SCHED;
    const rnd = rng(SEED), gp = {}, games = [], byTeam = {};
    PRO.forEach((t) => { gp[t[0]] = 0; byTeam[t[0]] = {}; });
    let wk2;
    while (!(wk2 = planWeek2(rnd))) { /* retry with the next random draws */ }
    const perDow = [8, 7, 6, 9, 6, 8, 7], pool = [1170, 1170, 1200, 1230, 1260, 1320, 1350, 930, 780];
    let gid = 401800000;
    for (let sp = 1; sp <= FINAL; sp++) {
      if (sp >= 116 && sp <= 121) continue; // All-Star break
      let ts;
      if (sp >= 7 && sp <= 13) ts = wk2[sp].slice();
      else ts = PRO.map((t) => t[0]).sort((a, b) => gp[a] + rnd() * 2.5 - (gp[b] + rnd() * 2.5)).slice(0, 2 * perDow[(sp + 1) % 7]);
      shuffle(ts, rnd);
      const times = sp === 10 ? [1170, 1200, 1350] : shuffle(pool.slice(), rnd);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const flip = rnd() < 0.5;
        const g = { id: ++gid, date: etMs(sp, times[(i / 2) % times.length]), homeProTeamId: flip ? ts[i] : ts[i + 1], awayProTeamId: flip ? ts[i + 1] : ts[i],
          scoringPeriodId: sp, startTimeTBD: false, statsOfficial: sp < CUR };
        games.push(g);
        byTeam[ts[i]][sp] = g; byTeam[ts[i + 1]][sp] = g;
        gp[ts[i]]++; gp[ts[i + 1]]++;
      }
    }
    SCHED = { games, byTeam, game: (t, sp) => byTeam[t][sp] || null, gpThrough: (t, sp) => Object.keys(byTeam[t]).filter((k) => +k <= sp).length };
    return SCHED;
  }

  function proRaw() {
    const S = schedule();
    const teams = [{ id: 0, abbrev: 'FA', location: 'Free', name: 'Agent', proGamesByScoringPeriod: {} }].concat(PRO.map((t) => {
      const by = {};
      Object.keys(S.byTeam[t[0]]).forEach((sp) => { by[sp] = [S.byTeam[t[0]][sp]]; });
      return { id: t[0], abbrev: t[1], location: t[2], name: t[3], proGamesByScoringPeriod: by };
    }));
    return { id: SEASON, settings: { proTeams: teams } };
  }

  /* ------------------------------------------------------------ players + sim */

  const ROSTER_ALL = MINE.concat(THEIRS).map((x) => {
    const a = x.a, e = a[12] || {};
    const p = { id: a[0], name: a[1], pos: a[2], team: a[3], slot: a[4], pts: a[5], reb: a[6], ast: a[7], stl: a[8], blk: a[9], to: a[10], min: a[11],
      tid: x.tid, from: e.from || 1, to_: e.to || 999, inj: e.inj || 'ACTIVE' };
    p.fp = r1(tenths({ pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, to: p.to }) / 10);
    return p;
  });
  const onTeam = (p, sp) => p.from <= sp && sp <= p.to_;
  const slotOn = (p, sp) => (p.to_ < 999 ? 12 : p.slot); // dropped players sat on the bench

  function makeBox(p, share, rnd) {
    const r = Math.max(0.45, Math.min(1.8, share / p.fp));
    const j = (v, s) => Math.max(0, Math.round(v * (0.5 + 0.5 * r) + (rnd() - 0.5) * s));
    const b = { reb: j(p.reb, 6), ast: j(p.ast, 6), stl: Math.max(0, Math.round(p.stl + (rnd() - 0.5) * 3)), blk: Math.max(0, Math.round(p.blk + (rnd() - 0.5) * 2.4)),
      to: Math.max(0, Math.round(p.to + (rnd() - 0.5) * 4)), min: Math.round(p.min * (0.8 + 0.25 * r)) };
    b.pts = Math.max(0, Math.round(share - 1.2 * b.reb - 1.5 * b.ast - 3 * b.stl - 3 * b.blk + b.to));
    return b;
  }
  function solveLast(p, targetT, restT, rnd) { // pick reb/ast/stl so the day total hits the target exactly
    const base = makeBox(p, p.fp, rnd), c = [];
    for (let dr = -6; dr <= 6; dr++) for (let da = -6; da <= 6; da++) for (let ds = -1; ds <= 1; ds++) c.push([dr, da, ds]);
    c.sort((x, y) => Math.abs(x[0]) + Math.abs(x[1]) + 3 * Math.abs(x[2]) - Math.abs(y[0]) - Math.abs(y[1]) - 3 * Math.abs(y[2]));
    for (const [dr, da, ds] of c) {
      const b = Object.assign({}, base, { reb: base.reb + dr, ast: base.ast + da, stl: base.stl + ds, pts: 0 });
      if (b.reb < 0 || b.ast < 0 || b.stl < 0) continue;
      const rem = targetT - restT - tenths(b);
      if (rem >= 0 && rem % 10 === 0 && rem / 10 <= 62) { b.pts = rem / 10; return b; }
    }
    return null;
  }

  let PLAY = null; // PLAY[sp][playerId] = { box, g, fp(tenths/10) }
  function simulate() {
    if (PLAY) return PLAY;
    const rnd = rng(SEED + 7), S = schedule();
    PLAY = {};
    for (let sp = 1; sp <= CUR; sp++) {
      const day = (PLAY[sp] = {}), todo = [];
      ROSTER_ALL.forEach((p) => {
        const g = S.game(ID[p.team], sp);
        if (g && g.date <= NOW && p.inj !== 'OUT' && (DNP[p.name] || []).indexOf(sp) < 0) todo.push({ p, g });
      });
      Object.keys(TARGET[sp] || {}).forEach((tid) => {
        const cnt = todo.filter((x) => x.p.tid === +tid && onTeam(x.p, sp) && slotOn(x.p, sp) < 12);
        const T = TARGET[sp][tid], sumFp = cnt.reduce((s, x) => s + x.p.fp, 0);
        let rest = 0;
        cnt.forEach((x, i) => {
          x.box = i < cnt.length - 1 ? makeBox(x.p, (T * x.p.fp) / sumFp, rnd) : solveLast(x.p, Math.round(T * 10), rest, rnd);
          if (x.box) rest += tenths(x.box);
        });
      });
      todo.forEach((x) => {
        const frac = sp < CUR ? 1 : Math.max(0.1, Math.min(1, (NOW - x.g.date) / (2.4 * 3600e3)));
        const b = x.box || makeBox(x.p, x.p.fp * (0.7 + rnd() * 0.6) * frac, rnd);
        if (frac < 1) b.min = Math.round(x.p.min * frac);
        const tpm = Math.round(b.pts * 0.09), ftm = Math.round(b.pts * 0.2), fgm = Math.max(tpm, Math.round((b.pts - ftm - tpm) / 2));
        Object.assign(b, { tpm, fgm, fga: Math.round(fgm * 2.1) + 1 });
        day[x.p.id] = { box: b, g: x.g, fp: tenths(b) / 10 };
      });
    }
    return PLAY;
  }

  const perGame = (sp, rec) => ({ id: '05' + rec.g.id, statSourceId: 0, statSplitTypeId: 5, scoringPeriodId: sp, appliedTotal: rec.fp, appliedAverage: rec.fp,
    stats: { 0: rec.box.pts, 1: rec.box.blk, 2: rec.box.stl, 3: rec.box.ast, 6: rec.box.reb, 11: rec.box.to, 13: rec.box.fgm, 14: rec.box.fga, 17: rec.box.tpm, 40: rec.box.min, 42: 1 } });

  // tr (league-wide views only): minutes, starts and form, see trendOf. Adds stats 40 (minutes) and 41 (starts) and sets the last 7 / last 15 entries.
  function seasonStats(id, fp, gp, tr, min) {
    const h = (k) => hash01(id, k), e = (code, src, split, avg, n, mpg, gsr) => {
      const st = { 42: n };
      if (tr) { st[40] = Math.round(mpg * n); st[41] = Math.round(gsr * n); }
      return { id: code, statSourceId: src, statSplitTypeId: split, scoringPeriodId: 0, appliedTotal: r1(avg * n), appliedAverage: r1(avg), stats: st };
    };
    if (tr) {
      const proj = fp * (0.95 + 0.1 * h(2));
      return [e('002027', 0, 0, fp * (0.92 + 0.16 * h(1)), gp, min, tr.gsr), e('102027', 1, 0, proj, 70, min, tr.gsr),
        e('012027', 0, 1, proj * tr.lf * tr.f7, Math.min(gp, 7), tr.mpg15, tr.gs15), e('022027', 0, 2, proj * tr.lf, Math.min(gp, 15), tr.mpg15, tr.gs15),
        e('002026', 0, 0, fp * (0.9 + 0.12 * h(5)), 66, min, tr.gsr)];
    }
    return [e('002027', 0, 0, fp * (0.92 + 0.16 * h(1)), gp), e('102027', 1, 0, fp * (0.95 + 0.1 * h(2)), 70), e('012027', 0, 1, fp * (0.88 + 0.24 * h(3)), Math.min(gp, 7)),
      e('022027', 0, 2, fp * (0.9 + 0.2 * h(4)), Math.min(gp, 15)), e('002026', 0, 0, fp * (0.9 + 0.12 * h(5)), 66)];
  }

  // Minutes / starts / form over the last 15 games versus the season, for the Trends view. Most players are steady; a few trend up or down,
  // change role (starts) or minutes. Thresholds match SPEC Phase 2 (tags need 15%, 3 points; roles need 0.6 / 0.4 start rates or 4 minutes).
  function trendOf(p) {
    const h = (k) => hash01(p.id, 20 + k), role = h(2), form = h(5);
    let gsr = Math.max(0, Math.min(1, (p.min - 22) / 10)), gs15 = gsr, mpg15 = p.min + (h(3) - 0.5) * 4;
    if (role < 0.10) { if (gsr < 0.7) { gsr = 0.2; gs15 = 0.85; mpg15 = p.min + 3; } } // new starter
    else if (role < 0.14) { if (gsr >= 0.6) { gsr = Math.max(gsr, 0.85); gs15 = 0.15; mpg15 = p.min - 3; } } // lost his starting spot
    else if (role < 0.19) mpg15 = p.min + 5; // more minutes
    else if (role < 0.24) mpg15 = p.min - 5; // fewer minutes
    return { gsr, gs15, mpg15: Math.max(8, mpg15), f7: 0.9 + 0.2 * h(6), lf: FORM[p.name] || (form < 0.08 ? 0.78 : form > 0.92 ? 1.22 : 0.93 + 0.14 * h(4)) };
  }
  const FORM = { 'Desmond Bane': 1.22, 'Dyson Daniels': 1.2, 'Jarrett Allen': 0.8 }; // last-15 form vs projection by name (so the demo team shows a sell-high and a falling tag)

  function playerObj(base, sp, deep) {
    const S = schedule(), parts = base.name.split(' ');
    const gp = base.gp != null ? base.gp : Math.max(2, S.gpThrough(ID[base.team], CUR - 1) - (base.inj === 'OUT' ? 5 : Math.floor(hash01(base.id, 9) * 2)));
    const stats = deep ? seasonStats(base.id, base.fp, gp, trendOf(base), base.min) : seasonStats(base.id, base.fp, gp);
    const rec = sp != null && simulate()[sp] && simulate()[sp][base.id];
    if (rec) stats.push(perGame(sp, rec));
    return { id: base.id, fullName: base.name, firstName: parts[0], lastName: parts.slice(1).join(' '), proTeamId: ID[base.team], defaultPositionId: POS.indexOf(base.pos.split('/')[0]) + 1,
      eligibleSlots: eligibleSlots(base.pos), injuryStatus: base.inj, ownership: { percentOwned: base.own != null ? base.own : Math.min(99.8, 60 + base.fp), percentChange: r1((hash01(base.id, 6) - 0.5) * 3) }, stats };
  }

  const FA_LIST = FAS.map((a, i) => ({ id: a[0] === 'Jock Landale' ? 4432194 : 4600001 + i, name: a[0], pos: a[1], team: a[2], fp: a[3], own: a[4], flag: a[5],
    inj: a[5] === 'DTD' ? 'DAY_TO_DAY' : a[5] === 'OUT' ? 'OUT' : 'ACTIVE' }));

  /* ------------------------------------------------------------------ responses */

  function leagueRaw() {
    return {
      id: LEAGUE, seasonId: SEASON, segmentId: 0, scoringPeriodId: CUR,
      settings: { name: 'Hardwood Syndicate', size: 16,
        scoringSettings: { scoringType: 'H2H_POINTS' },
        rosterSettings: { lineupSlotCounts: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0, 9: 0, 10: 0, 11: 3, 12: 3, 13: 1 } },
        acquisitionSettings: { matchupAcquisitionLimit: 1, matchupLimitPerScoringPeriod: true },
        scheduleSettings: { matchupPeriodCount: 19, matchupPeriods: (() => {
          const m = {}; for (let i = 1; i <= 20; i++) m[i] = [i]; m[21] = [21, 22]; m[22] = [23, 24]; return m; })() } },
      status: { currentMatchupPeriod: 2, latestScoringPeriod: CUR, firstScoringPeriod: 1, finalScoringPeriod: FINAL, isActive: true },
      teams: FANTASY_TEAMS.map((name, i) => {
        const id = i + 1, w = id === ME ? 1 : id === OPP ? Math.floor(hash01(id, 11) * 2) : leagueSim().wins[id];
        return { id, name, abbrev: name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase(), owners: ['{DEM0' + String(id).padStart(4, '0') + '-0000-4000-8000-000000000000}'],
          logo: '', record: { overall: { wins: w, losses: 1 - w, ties: 0 } },
          transactionCounter: { acquisitions: id === ME ? 2 : 0, drops: id === ME ? 2 : 0, matchupAcquisitionTotals: id === ME ? { 1: 0, 2: 2 } : {} } };
      }),
    };
  }

  function teamDay(tid, sp) { // counted points for a team on a scoring period, from the simulated games
    const day = simulate()[sp] || {};
    let t = 0;
    ROSTER_ALL.forEach((p) => { if (p.tid === tid && onTeam(p, sp) && slotOn(p, sp) < 12 && day[p.id]) t += day[p.id].fp; });
    return r1(t);
  }
  const OTHERS = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

  function matchups(n, withPoints) {
    const out = [];
    for (let m = 1; m <= n; m++) {
      const opp = m <= 19 ? OTHERS[(m + 1) % 15] : OTHERS[(m + 1) % 15], meHome = m % 2 === 1;
      const side = (teamId, tid) => {
        const by = {};
        if (withPoints && m <= 2) {
          const sps = m === 1 ? [1, 2, 3, 4, 5, 6] : [7, 8, 9];
          sps.forEach((sp) => { by[sp] = TARGET[sp] ? TARGET[sp][tid] : teamDay(tid, sp); });
        }
        const total = r1(Object.keys(by).reduce((s, k) => s + by[k], 0));
        return { teamId, totalPoints: total, pointsByScoringPeriod: by };
      };
      out.push({ id: m, matchupPeriodId: m, winner: 'UNDECIDED', home: side(meHome ? ME : opp, meHome ? ME : OPP), away: side(meHome ? opp : ME, meHome ? OPP : ME) });
    }
    return out;
  }

  function scoreRaw(sp) {
    const mp = CAL_TO_MP(Math.floor(sp / 7) + 1);
    const sched = matchups(22, false);
    sched.forEach((s) => { if (s.matchupPeriodId === mp) { s.home.rosterForCurrentScoringPeriod = { entries: [] }; s.away.rosterForCurrentScoringPeriod = { entries: [] }; } });
    return { id: LEAGUE, seasonId: SEASON, scoringPeriodId: sp, schedule: sched };
  }

  const rosterEntry = (p, tid, sp, deep) => ({
    playerId: p.id, lineupSlotId: slotOn(p, sp), injuryStatus: p.inj, status: 'NORMAL',
    playerPoolEntry: { id: p.id, onTeamId: tid, player: playerObj(p, sp, deep) } });

  function rosterRaw(sp, ids) {
    const teams = ids.map((tid) => {
      const src = tid === ME ? ME : OPP; // any other team shows the Lebrontocracy roster (demo shortcut)
      const entries = ROSTER_ALL.filter((p) => p.tid === src && onTeam(p, sp)).map((p) => rosterEntry(p, tid, sp, false));
      return { id: tid, roster: { entries } };
    });
    return { id: LEAGUE, scoringPeriodId: sp, teams };
  }

  /* ------------------------------------------------------- league-wide data (all 16 teams) */

  const FIRST = ('Marcus Jalen Darius Terrence DeAndre Malik Isaiah Tyrese Kendrick Devonte Cameron Trey Nathan Jordan Caleb Xavier Andre Dominic Elijah Mason Brandon Miles ' +
    'Josh Tyler Austin Kyle Zach Cole Aaron Brice Rashad Keon Lamar Quincy Jamal Corey Dwight Marvin Patrick Troy Wendell Julian Nolan Gabe Bruno Davion Amir Jabari ' +
    'Khalil Cedric Reggie Terrell Jaden Chance Gordon Rodney Mitchell Tristan Donovan Ezra Ronnie Damon Silas Lonnie Everett Hakeem Bryce Anton Felix Joaquin Kellen').split(' ');
  const LAST = ('Whitfield Holloway Ashford Okafor Mercer Calloway Sutton Greer Pruitt Delaney Fontaine Lockhart Okonkwo Adeyemi Kowalski Navarro Petrovic Lindqvist Hargrove ' +
    'Thibodeaux Vasquez Nakamura Abernathy Beaumont Castellano Dunmore Eastwood Fairchild Gallagher Harlow Jernigan Kingsley Langston Merriweather Newsome Oyelaran Pemberton ' +
    'Radford Sandoval Tillman Underhill Vance Whitaker Yarbrough Zielinski Acheampong Boateng Cisse Egwu Fofana Gueye Haidara Ibekwe Jovanovic Kovacs Lazarevic Mitrovic ' +
    'Novak Obradovic Pavlovic Radulovic Todorovic Vukovic Zivkovic Bellamy Crenshaw Devereaux Ellison Fitzgerald Gaines Hightower Ivory Jeffries Kimbrough Lattimore ' +
    'Montague Prescott Rutledge Strickland Tolliver Upshaw Valentine Wainwright Yates Zeller Bannister Cordero Dawkins Escobar Fenwick Gilchrist Hendricks Ibarra Jaramillo').split(' ');
  const POS_ALL = ['PG', 'SG', 'SF', 'PF', 'C', 'PG/SG', 'SG/SF', 'SF/PF', 'PF/C'];
  const STARTER_SLOTS = [0, 1, 2, 3, 4, 5, 6, 11, 11, 11]; // PG SG SF PF C G F UTIL x3, as the league's lineup slots
  const SLOT_POS = { 0: ['PG', 'PG', 'PG/SG'], 1: ['SG', 'SG', 'PG/SG', 'SG/SF'], 2: ['SF', 'SF', 'SG/SF', 'SF/PF'], 3: ['PF', 'PF', 'SF/PF', 'PF/C'],
    4: ['C', 'C', 'C', 'PF/C'], 5: ['PG', 'SG', 'PG/SG'], 6: ['SF', 'PF', 'SF/PF'], 11: POS_ALL };
  const STARTER_FP = [44, 39, 36, 33, 31, 29, 27, 25, 23, 21], BENCH_FP = [18, 16, 14];
  const LEAGUE_IDS = FANTASY_TEAMS.map((n, i) => i + 1);
  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

  let GEN = null;
  function generatedTeams() { // { teamId: base player[] } for the 14 teams that are neither ME nor OPP: 10 starters, 3 bench, usually 1 on IR
    if (GEN) return GEN;
    const taken = new Set(ROSTER_ALL.map((p) => p.name).concat(FA_LIST.map((f) => f.name)));
    let nextId = 4700001;
    GEN = {};
    LEAGUE_IDS.filter((t) => t !== ME && t !== OPP).forEach((tid) => {
      const rnd = rng(SEED * 1000 + tid), strength = 0.92 + 0.16 * hash01(tid, 41), fps = shuffle(STARTER_FP.slice(), rnd), list = [];
      const add = (slot, pos, fpBase, inj) => {
        let name;
        do { name = pick(FIRST, rnd) + ' ' + pick(LAST, rnd); } while (taken.has(name));
        taken.add(name);
        const fp = r1(fpBase * strength * (0.94 + 0.12 * rnd()));
        list.push({ id: nextId++, name, pos, team: pick(PRO, rnd)[1], slot, tid, fp, inj, from: 1, to_: 999,
          min: Math.max(14, Math.min(37, Math.round(14 + fp * 0.52 + (rnd() - 0.5) * 4))), own: r1(Math.min(99.8, 30 + fp * 1.9)) });
      };
      STARTER_SLOTS.forEach((slot, i) => add(slot, pick(SLOT_POS[slot], rnd), fps[i], rnd() < 0.08 ? 'DAY_TO_DAY' : 'ACTIVE'));
      BENCH_FP.forEach((f) => { const r = rnd(); add(12, pick(POS_ALL, rnd), f, r < 0.1 ? 'DAY_TO_DAY' : r < 0.14 ? 'OUT' : 'ACTIVE'); });
      if (hash01(tid, 42) < 0.7) add(13, pick(POS_ALL, rnd), 26 + 8 * rnd(), 'OUT');
      GEN[tid] = list;
    });
    return GEN;
  }

  // Round robin: ME meets the same opponent as in matchups(), the other 14 teams pair up around it.
  function pairings(m) {
    const r = (m + 1) % 15, o = OTHERS[r], out = [m % 2 === 1 ? [ME, o] : [o, ME]];
    for (let i = 1; i <= 7; i++) {
      const a = OTHERS[(r + i) % 15], b = OTHERS[(r - i + 15) % 15];
      out.push((m + i) % 2 ? [a, b] : [b, a]);
    }
    return out;
  }

  // Points of every team on the finished days (matchup 1 = days 1-6, matchup 2 = days 7-9) and the week 1 results (they set the records).
  let LSIM = null;
  function leagueSim() {
    if (LSIM) return LSIM;
    const S = schedule(), gen = generatedTeams(), mine = matchups(2, true), pts = {}, RANGE = { 1: [1, 6], 2: [7, 9] };
    const sideOf = (m, tid) => (m.home.teamId === tid ? m.home : m.away);
    const w1Opp = mine[0].home.teamId === ME ? mine[0].away : mine[0].home; // ME's week 1 opponent carries Lebrontocracy's numbers, as in matchups()
    pts[ME] = Object.assign({}, sideOf(mine[0], ME).pointsByScoringPeriod, sideOf(mine[1], ME).pointsByScoringPeriod);
    pts[OPP] = Object.assign({}, w1Opp.pointsByScoringPeriod, sideOf(mine[1], OPP).pointsByScoringPeriod);
    Object.keys(gen).forEach((tid) => {
      const rnd = rng(SEED + 500 + +tid);
      pts[tid] = {};
      for (let sp = 1; sp <= 9; sp++) {
        let t = 0;
        gen[tid].forEach((p) => { if (p.slot < 12 && p.inj !== 'OUT' && S.game(ID[p.team], sp)) t += p.fp * (0.7 + 0.6 * rnd()); });
        pts[tid][sp] = r1(t);
      }
    });
    const sideBy = (tid, mp) => {
      const rg = RANGE[mp], by = {}, src = mp === 1 && tid === w1Opp.teamId ? OPP : tid;
      if (rg) for (let sp = rg[0]; sp <= rg[1]; sp++) by[sp] = pts[src][sp];
      return by;
    };
    const total = (tid, mp) => { const by = sideBy(tid, mp); return r1(Object.keys(by).reduce((s, k) => s + by[k], 0)); };
    // Lebrontocracy's week 1 result must match its record (hash based, as before): rescale its opponent's days if needed.
    const oppRival = pairings(1).filter((x) => x.indexOf(OPP) >= 0 && x.indexOf(ME) < 0)[0];
    if (oppRival) {
      const y = oppRival[0] === OPP ? oppRival[1] : oppRival[0], oppWins = Math.floor(hash01(OPP, 11) * 2) === 1;
      if ((total(OPP, 1) > total(y, 1)) !== oppWins) {
        const f = (oppWins ? 0.92 : 1.08) * total(OPP, 1) / total(y, 1);
        for (let sp = 1; sp <= 6; sp++) pts[y][sp] = r1(pts[y][sp] * f);
      }
    }
    const wins = {};
    pairings(1).forEach((x) => { const a = total(x[0], 1) > total(x[1], 1); wins[x[0]] = a ? 1 : 0; wins[x[1]] = a ? 0 : 1; });
    LSIM = { sideBy, total, wins };
    return LSIM;
  }

  function rosterAll(sp) { // current rosters of all 16 teams (mRoster without rosterForTeamId); extra minutes / starts stats for the Trends view
    const gen = generatedTeams();
    return { id: LEAGUE, scoringPeriodId: sp, teams: LEAGUE_IDS.map((tid) => ({ id: tid, roster: { entries:
      (tid === ME || tid === OPP ? ROSTER_ALL.filter((p) => p.tid === tid && onTeam(p, sp)) : gen[tid]).map((p) => rosterEntry(p, tid, sp, true)) } })) };
  }

  function matchupsAll() { // every matchup of the season (mMatchup without a team filter): 22 periods x 8 pairings
    const sim = leagueSim(), out = [];
    for (let m = 1; m <= 22; m++) {
      pairings(m).forEach((x) => {
        const side = (teamId) => ({ teamId, totalPoints: sim.total(teamId, m), pointsByScoringPeriod: sim.sideBy(teamId, m) });
        const home = side(x[0]), away = side(x[1]);
        out.push({ id: out.length + 1, matchupPeriodId: m, winner: m === 1 ? (home.totalPoints > away.totalPoints ? 'HOME' : 'AWAY') : 'UNDECIDED', home, away });
      });
    }
    return out;
  }

  function konaRaw() {
    const players = FA_LIST.slice().sort((a, b) => b.own - a.own).map((f) => ({ id: f.id, status: f.flag === 'W' ? 'WAIVERS' : 'FREEAGENT',
      waiverProcessDate: f.flag === 'W' ? Date.UTC(2026, 9, 30, 7, 0) : undefined, onTeamId: 0, player: playerObj(f, null) }));
    return { players };
  }

  function txRaw() {
    const sharpe = 4576060, landale = 4432194, mk = (id, type, status, sp, items, team) => ({ id: 'demo-' + id, teamId: team || ME, type, status, scoringPeriodId: sp,
      items: items.map((x) => ({ type: x[0], playerId: x[1] })) });
    return { transactions: [
      mk(1, 'FREEAGENT', 'EXECUTED', 8, [['ADD', 4433134], ['DROP', 4683021]]),
      mk(2, 'FREEAGENT', 'EXECUTED', 9, [['ADD', sharpe], ['DROP', 4712902]]),
      mk(3, 'WAIVER', 'PENDING', CUR, [['ADD', landale], ['DROP', sharpe]]),
      mk(4, 'FREEAGENT', 'EXECUTED', 9, [['ADD', 4600001 + 2]], 9),
      mk(5, 'ROSTER', 'EXECUTED', 9, [], ME),
    ] };
  }

  function handle(rel, q) {
    const views = q.views || [], has = (v) => views.indexOf(v) >= 0, sp = q.params && q.params.scoringPeriodId != null ? +q.params.scoringPeriodId : CUR;
    if (/^seasons\/\d+$/.test(rel) && has('proTeamSchedules_wl')) return proRaw();
    if (/\/leagues\/\d+$/.test(rel)) {
      if (has('mRoster')) {
        const ids = q.params && q.params.rosterForTeamId;
        return ids == null || (Array.isArray(ids) && !ids.length) ? rosterAll(sp) : rosterRaw(sp, [].concat(ids).map(Number));
      }
      if (has('mMatchupScore')) return scoreRaw(sp);
      if (has('kona_player_info')) return konaRaw();
      if (has('mTransactions2')) return txRaw();
      if (has('mMatchup')) {
        const f = q.filter && q.filter.schedule && q.filter.schedule.filterTeamIds;
        return { id: LEAGUE, schedule: f ? matchups(19, true) : matchupsAll() };
      }
      if (has('mSettings') || has('mTeam') || has('mStatus')) return leagueRaw();
    }
    const err = new Error('Demo data has no answer for ' + rel + '?' + views.join(','));
    err.status = 404;
    throw err;
  }

  root.WPDemo = {
    config: { leagueId: LEAGUE, season: SEASON, teamId: ME },
    now: NOW,
    respond(rel, q) {
      return new Promise((resolve, reject) => {
        setTimeout(() => { try { resolve(clone(handle(rel, q || {}))); } catch (e) { reject(e); } }, 15);
      });
    },
  };
})(typeof self !== 'undefined' ? self : globalThis);
