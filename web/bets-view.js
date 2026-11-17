/* The Bets view: the night's player props at Betano and Betclic (and DraftKings), each priced
   against DraftKings' line with its margin removed and the over correction applied, with the research
   behind every pick folded underneath. app.js hosts it (tab, top bar, body); it renders its own list
   and check form so typing and filtering do not redraw the page. */
(function (root) {
  'use strict';

  const B = () => root.WPBets;
  const store = {
    get(k) { try { return JSON.parse(root.localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const BOOKS = { pt: ['Betano', 'Betclic'], Betano: ['Betano'], Betclic: ['Betclic'], all: ['Betano', 'Betclic', 'DraftKings'] };
  const BOOK_LABEL = { pt: 'Betano + Betclic', Betano: 'Betano', Betclic: 'Betclic', all: 'All, with DraftKings' };
  const STAT_GROUPS = { all: null, pts: ['pts'], reb: ['reb'], ast: ['ast'], tpm: ['tpm'], combo: ['pr', 'pa', 'ra', 'pra'], def: ['stl', 'blk'] };
  const STAT_LABEL = { all: 'Every stat', pts: 'Points', reb: 'Rebounds', ast: 'Assists', tpm: '3-pointers', combo: 'Combos (PRA…)', def: 'Steals, blocks' };
  const KIND_LABEL = { all: 'Over/under and ladders', ou: 'Over/under only', ladder: 'Ladders only (X+)' };
  const MINP_LABEL = { 0: 'Any chance', 0.3: '30% or more', 0.5: '50% or more' };
  const PAGE = 24;

  const etToday = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const pct = (p) => (p == null || !isFinite(p) ? '–' : Math.round(p * 100) + '%');
  const evText = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%';
  const dec2 = (d) => (d > 0 && isFinite(d) ? d.toFixed(2) : '–');
  const n1 = (x) => (x == null || !isFinite(x) ? '–' : x.toFixed(1));
  const clock = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };

  function create(opts) {
    const esc = opts.esc;
    const saved = store.get('wp:bets') || {};
    const S = {
      mode: saved.mode === 'record' ? 'record' : 'night',
      day: saved.day === 'tomorrow' ? 'tomorrow' : 'today',
      log: null, logged: 0, logError: null, stake: saved.stake || '',
      rec: { loading: false, error: null, msg: '', filter: 'value', shown: 40, at: 0 },
      f: Object.assign({ book: 'pt', stat: 'all', kind: 'all', minP: 0, q: '' }, saved.f || {}),
      night: null, board: null, date: null, loading: false, error: null, msg: '', token: 0,
      open: new Set(), shown: PAGE, memo: {},
      check: { pid: '', m: 'pts', side: 'over', line: '', dec: '' },
    };
    if (!BOOKS[S.f.book]) S.f.book = 'pt';
    const keep = () => store.set('wp:bets', { mode: S.mode, day: S.day, stake: S.stake, f: { book: S.f.book, stat: S.f.stat, kind: S.f.kind, minP: S.f.minP } });
    const rerender = () => opts.rerender();
    const dateFor = (day) => (day === 'tomorrow' ? addDays(etToday(), 1) : etToday());
    let _client = null;
    const client = () => (_client = _client || root.WPOdds.create({}));
    const P = () => root.WPPicks;
    const seasonOf = (date) => (+date.slice(5, 7) >= 8 ? +date.slice(0, 4) + 1 : +date.slice(0, 4));

    // Value picks go into the track record (data/picks.json on the local server) as soon as they show.
    async function logBoard() {
      if (!P() || !S.board) return;
      try {
        if (!S.log) S.log = await client().picks.load();
        const changed = P().merge(S.log, P().fromBoard(S.board, S.night, Date.now()));
        if (changed.length) await client().picks.save(changed);
        S.logged = Object.keys(S.log).filter((k) => S.log[k].flagged && S.log[k].date === S.date).length;
        S.logError = null;
      } catch (e) {
        S.logError = e.message || String(e);
      }
    }

    // The track record: load it, grade what finished, show it.
    async function ensureRecord(force) {
      if (S.rec.loading || (!force && S.log && Date.now() - S.rec.at < 5 * 60 * 1000)) return;
      S.rec.loading = true; S.rec.error = null; S.rec.msg = 'Reading the track record…';
      rerender();
      try {
        if (!P() || !root.WPOdds) throw new Error('picklog.js or odds.js did not load. Make sure they sit next to index.html, then reload.');
        S.log = await client().picks.load();
        const todo = P().ungraded(S.log, etToday());
        const seasons = {};
        todo.forEach((r) => { (seasons[seasonOf(r.date)] = seasons[seasonOf(r.date)] || []).push(r); });
        for (const season of Object.keys(seasons)) {
          S.rec.msg = 'Grading ' + todo.length + ' finished picks…';
          const el = document.getElementById('wpb-msg');
          if (el) el.textContent = S.rec.msg;
          const { rows, closes } = await client().loadResults(seasons[season], +season);
          const graded = seasons[season].map((r) => P().grade(r, rows[r.athlete], closes[r.event], B().DEFAULTS, Date.now())).filter(Boolean);
          graded.forEach((g) => { S.log[g.id] = g; });
          if (graded.length) await client().picks.save(graded);
        }
        S.rec.at = Date.now();
      } catch (e) {
        if (root.console) console.error(e);
        S.rec.error = e;
      }
      S.rec.loading = false;
      rerender();
    }

    async function ensure(force) {
      if (S.mode === 'record') return ensureRecord(force);
      const want = dateFor(S.day);
      if (S.loading || (S.board && !force && S.date === want)) return;
      const my = ++S.token;
      S.loading = true; S.error = null; S.msg = 'Reading the schedule…';
      rerender();
      try {
        if (!root.WPOdds || !B()) throw new Error('bets.js or odds.js did not load. Make sure they sit next to index.html, then reload.');
        const night = await root.WPOdds.create({}).loadNight(want, {
          season: opts.season(),
          progress: (m) => { if (my !== S.token) return; S.msg = m; const el = document.getElementById('wpb-msg'); if (el) el.textContent = m; },
        });
        if (my !== S.token) return;
        S.night = night;
        S.board = B().buildBoard(night, root.WPStatFactors || null);
        S.date = night.date; S.memo = {}; S.shown = PAGE;
        await logBoard();
      } catch (e) {
        if (my !== S.token) return;
        if (root.console) console.error(e);
        S.error = e;
      }
      S.loading = false;
      rerender();
    }

    /* ---------------------------------------------------------- filtering */

    function picks() {
      if (!S.board) return [];
      const books = BOOKS[S.f.book];
      const stats = STAT_GROUPS[S.f.stat];
      const q = B().normName(S.f.q);
      return S.board.picks.filter((p) => books.indexOf(p.book) >= 0 &&
        (!stats || stats.indexOf(p.entry.m) >= 0) &&
        (S.f.kind === 'all' || (S.f.kind === 'ladder') === (p.side === 'atleast')) &&
        p.p >= S.f.minP &&
        (!q || B().normName(p.entry.name).indexOf(q) >= 0 || B().normName(p.entry.ctx.team + p.entry.ctx.opp).indexOf(q) >= 0));
    }

    /* ------------------------------------------------------------- render */

    function html() {
      return '<div class="wp-view wpb">' + headHTML() + (S.mode === 'record' ? recordHTML() : bodyHTML()) + '</div>';
    }

    function headHTML() {
      const n = S.mode === 'night' ? S.night : null;
      const night = S.mode === 'night';
      const dayBtn = (d, l) => '<button type="button" class="wpb-seg' + (night && S.day === d ? ' is-on' : '') + '" data-bact="day" data-day="' + d + '" aria-pressed="' + (night && S.day === d) + '">' + l + '</button>';
      const recBtn = '<button type="button" class="wpb-seg' + (!night ? ' is-on' : '') + '" data-bact="record" aria-pressed="' + !night + '">Track record</button>';
      const src = [];
      if (n) {
        const dk = n.games.filter((g) => g.books.DraftKings).length;
        src.push(chip('DraftKings', dk ? dk + ' of ' + n.games.length + ' games · the reference price' : 'no lines yet', !!dk));
        ['Betano', 'Betclic'].forEach((b) => {
          const k = n.games.filter((g) => g.books[b] && Object.keys(g.books[b].players).length).length;
          src.push(chip(b, n.errors[b] ? 'could not be read' : k ? k + ' games' + (b === 'Betclic' ? ' · points and PRA' : '') : 'no player lines yet', !n.errors[b] && k > 0));
        });
      }
      return '<section class="wp-sec wpb-head"><div class="wp-sec-h wp-sec-h--split"><div>' +
        '<h2 id="h-bets">Bets</h2>' +
        '<p>Every player prop at Betano and Betclic, priced against DraftKings’ line with its margin taken off. A bet is value when the book pays more than its fair odds. Open any pick for the research behind it.</p>' +
        '</div><div class="wpb-days" role="group" aria-label="Night">' + dayBtn('today', 'Tonight') + dayBtn('tomorrow', 'Tomorrow') + recBtn + '</div></div>' +
        (src.length ? '<div class="wpb-src">' + src.join('') +
          (S.logError ? '<span class="wpb-srcchip is-off"><b>Track record</b> not saved: ' + esc(S.logError) + '</span>' : S.logged ? '<span class="wpb-srcchip"><b>Track record</b> ' + S.logged + ' value picks logged for this night</span>' : '') +
          (n ? '<span class="wpb-at">Prices from ' + esc(clock(n.loadedAt)) + '</span>' : '') + '</div>' : '') +
        '</section>';
    }
    function chip(name, text, ok) {
      return '<span class="wpb-srcchip' + (ok ? '' : ' is-off') + '"><b>' + esc(name) + '</b> ' + esc(text) + '</span>';
    }

    function bodyHTML() {
      if (S.loading && !S.board) return '<div class="wp-loading"><span class="wp-spin wpb-spin" aria-hidden="true"></span><p id="wpb-msg">' + esc(S.msg) + '</p><p class="wp-dim">The first load of a night reads every player’s game log; later loads are quick.</p></div>';
      if (S.error && !S.board) {
        return '<div class="wp-panel wp-errorpanel" role="alert"><h2>Could not load the night</h2><p>' + esc(S.error.message || String(S.error)) + '</p>' +
          '<p class="wp-dim">The Bets view needs the local server (python server.py). If it is running, restart it once so it has the new /odds routes.</p>' +
          '<div class="wp-form-actions"><button type="button" class="wp-btn wp-btn--primary" data-bact="retry">Try again</button></div></div>';
      }
      if (!S.board) return '';
      const n = S.night;
      if (!n.games.length) return '<div class="wp-empty"><p>No NBA games ' + (S.day === 'tomorrow' ? 'tomorrow' : 'tonight') + '.</p></div>';
      return gamesHTML(n) + filtersHTML() + '<section class="wp-sec wpb-picks" aria-labelledby="h-value"><div id="wpb-list">' + listHTML() + '</div></section>' + checkHTML() + footHTML();
    }

    function gamesHTML(n) {
      const tile = (g) => {
        const tot = g.total, sp = g.spread;
        const imp = (home) => (tot && sp != null ? (tot / 2 - (home ? sp : -sp) / 2) : null);
        const fav = sp == null ? '' : sp < 0 ? g.home.ab + ' ' + sp : sp > 0 ? g.away.ab + ' ' + (-sp) : 'Pick';
        const live = g.state !== 'pre';
        return '<li class="wpb-game' + (live ? ' is-live' : '') + '">' +
          '<div class="wpb-gteams"><b>' + esc(g.away.ab) + '</b><span>@</span><b>' + esc(g.home.ab) + '</b></div>' +
          '<div class="wpb-gmeta">' + (live ? (g.state === 'post' ? 'Final' : 'Live') : esc(clock(g.start))) + (tot ? ' · total ' + tot : '') + (fav ? ' · ' + esc(fav) : '') + '</div>' +
          (imp(true) != null ? '<div class="wpb-gimp">' + esc(g.away.ab) + ' ' + n1(imp(false)) + ' · ' + esc(g.home.ab) + ' ' + n1(imp(true)) + '</div>' : '') +
          ((g.b2b && (g.b2b.home || g.b2b.away)) ? '<div class="wpb-gb2b">Back-to-back: ' + [g.b2b.away ? g.away.ab : '', g.b2b.home ? g.home.ab : ''].filter(Boolean).join(', ') + '</div>' : '') +
          '</li>';
      };
      return '<section class="wp-sec wpb-gamesec" aria-label="Games"><ul class="wpb-games">' + n.games.map(tile).join('') + '</ul></section>';
    }

    function filtersHTML() {
      const sel = (name, labels, val) => '<label class="wpb-f"><span>' + name + '</span><select data-bact="f-' + name.toLowerCase() + '" data-focus="bets-' + name.toLowerCase() + '">' +
        Object.keys(labels).map((k) => '<option value="' + k + '"' + (String(val) === k ? ' selected' : '') + '>' + esc(labels[k]) + '</option>').join('') + '</select></label>';
      return '<div class="wpb-filters" role="search">' +
        sel('Book', BOOK_LABEL, S.f.book) + sel('Stat', STAT_LABEL, S.f.stat) + sel('Type', KIND_LABEL, S.f.kind) + sel('Chance', MINP_LABEL, S.f.minP) +
        '<label class="wpb-f wpb-q"><span>Player or team</span><input type="search" data-bact="q" data-focus="bets-q" value="' + esc(S.f.q) + '" placeholder="Brunson, NY…" autocomplete="off"></label>' +
        '</div>';
    }

    function listHTML() {
      const all = picks();
      const value = all.filter((p) => p.ev > 0);
      const head = (t, sub) => '<div class="wp-sec-h"><h2 id="h-value">' + t + '</h2><p>' + sub + '</p></div>';
      if (!all.length) return head('Value', 'Nothing matches these filters.') + '<div class="wp-empty"><p>Try another book or stat, or clear the search.</p></div>';
      let out;
      if (value.length) {
        out = head(value.length + (value.length === 1 ? ' bet pays' : ' bets pay') + ' more than fair', 'Best first: the extra you expect back per euro staked. Fair odds come from DraftKings’ line without its margin, with overs marked down by how often they have fallen short this season.');
        out += cards(value);
      } else {
        out = head('No value right now', 'No price here pays more than its fair odds. These come closest; the fair odds tell you what another book would need to pay.');
        out += cards(all);
      }
      return out;
    }
    function cards(list) {
      const shown = list.slice(0, S.shown);
      return '<ol class="wpb-list">' + shown.map(cardHTML).join('') + '</ol>' +
        (list.length > shown.length ? '<div class="wpb-more"><button type="button" class="wp-btn" data-bact="more">Show ' + Math.min(PAGE, list.length - shown.length) + ' more of ' + (list.length - shown.length) + '</button></div>' : '');
    }

    const sideText = (b) => (b.side === 'atleast' ? b.line + '+' : (b.side === 'over' ? 'Over ' : 'Under ') + b.line);

    function cardHTML(p) {
      const L = p.entry, M = B().MARKETS[L.m];
      const open = S.open.has(p.key);
      const stake = Math.min(0.025, Math.max(0, p.kelly / 4));
      const inj = L.injury && L.injury !== 'ACTIVE' ? '<span class="wpb-inj">' + esc(L.injury === 'DAY_TO_DAY' ? 'DTD' : L.injury.replace('_', ' ')) + '</span>' : '';
      return '<li class="wpb-card' + (p.ev > 0 ? ' is-value' : '') + (open ? ' is-open' : '') + '">' +
        '<button type="button" class="wpb-cardbtn" data-bact="open" data-key="' + esc(p.key) + '" aria-expanded="' + open + '">' +
        '<span class="wpb-ev"><b>' + evText(p.ev) + '</b><small>expected</small></span>' +
        '<span class="wpb-what"><span class="wpb-name">' + esc(L.name) + inj + '</span>' +
        '<span class="wpb-bet"><b>' + esc(M.label) + ' · ' + esc(sideText(p)) + '</b></span>' +
        '<span class="wpb-ctx">' + esc(L.ctx.team) + (L.ctx.home ? ' v ' : ' @ ') + esc(L.ctx.opp) + ' · ' + esc(clock(L.game.start)) + '</span></span>' +
        '<span class="wpb-price"><span class="wpb-book">' + esc(p.book) + '</span><b class="wpb-dec">' + dec2(p.dec) + '</b>' +
        '<small>fair ' + dec2(1 / p.p) + ' · ' + pct(p.p) + '</small></span>' +
        '<span class="wpb-stake" title="A quarter of the Kelly stake, at most 2.5% of your bankroll">' + (p.ev > 0 ? 'Stake ' + (stake * 100).toFixed(1) + '%' : 'No bet') + '</span>' +
        '<svg class="wpb-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        (open ? '<div class="wpb-deep">' + deepHTML(p) + '</div>' : '') +
        '</li>';
    }

    /* ------------------------------------------------------- the deep dive */

    function analysisFor(L) {
      if (S.memo[L.key]) return S.memo[L.key];
      const line = L.pr.anchor ? L.pr.anchor.line : Math.floor(L.pr.mu) + 0.5;
      const a = B().analysis({ rows: L.rows, prevRows: L.prev, m: L.m, line, ctx: L.ctx, F: root.WPStatFactors || null, grp: L.grp, mates: L.mates });
      S.memo[L.key] = { a, line };
      return S.memo[L.key];
    }

    function deepHTML(p) {
      const L = p.entry;
      const { a, line } = analysisFor(L);
      const side = p.side === 'under' ? 'under' : 'over';
      const why = L.proj ? B().reasons({ a, proj: L.proj, m: L.m, side, line: p.side === 'atleast' ? p.line - 0.5 : p.line, ctx: L.ctx, grp: L.grp, pr: L.pr }) : [];
      return placeHTML(p) + '<div class="wpb-grid">' +
        block('The price', priceTable(L, p)) +
        block('Chance of each total', distSVG(L, p) + '<p class="wpb-note">Mean ' + n1(L.pr.mu) + (L.pr.muModel != null ? ' · our projection ' + n1(L.pr.muModel) : '') + ' · DraftKings ' + L.pr.anchor.line + ' at ' + pct(L.pr.anchor.pOverRaw) + ' over without margin, ' + pct(L.pr.anchor.pOver) + ' after the over correction.</p>') +
        block('Last 10 games against ' + (p.side === 'atleast' ? (p.line - 0.5) : p.line), lastTenSVG(a, p) + hitHTML(a, p)) +
        block('Why', whyHTML(why, side)) +
        block('Matchup', matchupHTML(a, L)) +
        block('Projection', projHTML(a, L)) +
        '</div>' +
        '<p class="wpb-disclaim">Research, not a promise: on 16,146 DraftKings closing lines this season, neither these projections nor matchup or hit-rate rules beat the market. The edge, when there is one, is the price.</p>';
    }
    const block = (t, body) => '<section class="wpb-block"><h3>' + esc(t) + '</h3>' + body + '</section>';

    // "I placed this": the bet goes into the track record with your stake, at the price shown.
    function placeHTML(p) {
      if (!P() || P().BETTABLE.indexOf(p.book) < 0) return '';
      const rec = S.log && S.log[P().pickId(S.date, p)];
      const k = esc(p.key);
      if (rec && rec.placed) {
        return '<div class="wpb-place is-placed"><span>You placed <b>€' + esc(String(rec.placed.stake)) + '</b> at ' + dec2(rec.placed.dec) + '. It is in your track record.</span>' +
          '<button type="button" class="wp-btn wp-btn--quiet" data-bact="unplace" data-key="' + k + '">Remove</button></div>';
      }
      return '<div class="wpb-place"><label class="wpb-f wpb-num"><span>Stake €</span><input inputmode="decimal" data-bact="stake" data-key="' + k + '" data-focus="bets-stake" value="' + esc(String(S.stake || '')) + '" placeholder="10"></label>' +
        '<button type="button" class="wp-btn" data-bact="place" data-key="' + k + '">I placed this at ' + dec2(p.dec) + '</button>' +
        '<span class="wpb-note">Adds it to your track record with your stake.</span></div>';
    }

    async function setPlaced(key, stake) {
      const p = S.board && S.board.picks.find((x) => x.key === key);
      if (!p || !P()) return;
      try {
        if (!S.log) S.log = await client().picks.load();
        const id = P().pickId(S.date, p);
        const now = Date.now();
        let rec = S.log[id];
        if (stake == null) {
          if (!rec) return;
          if (rec.flagged) { rec = Object.assign({}, rec); delete rec.placed; S.log[id] = rec; await client().picks.save([rec]); }
          else { delete S.log[id]; await client().picks.save([], [id]); }
        } else {
          rec = Object.assign({}, rec || P().record(p, S.date, now, false), { placed: { stake, dec: p.dec, at: now } });
          S.log[id] = rec;
          await client().picks.save([rec]);
        }
        S.logError = null;
      } catch (e) {
        S.logError = e.message || String(e);
        return rerender();
      }
      redrawList();
    }

    function priceTable(L, p) {
      const D = L.pr.dist;
      const rows = [];
      L.pr.bets.filter((b) => b.side !== 'atleast').forEach((b) => { rows.push(b); });
      const byLine = {};
      rows.forEach((b) => { const k = b.book + '|' + b.line; (byLine[k] = byLine[k] || { book: b.book, line: b.line })[b.side] = b; });
      const ou = Object.values(byLine).sort((x, y) => x.line - y.line || x.book.localeCompare(y.book));
      const cell = (b) => (b ? '<td class="' + (b.ev > 0 ? 'is-pos' : '') + (b === p || b.key === p.key || (b.book === p.book && b.side === p.side && b.line === p.line) ? ' is-me' : '') + '">' + dec2(b.dec) + '<small>' + evText(b.ev) + '</small></td>' : '<td>–</td>');
      let h = '<table class="wpb-table"><thead><tr><th>Book</th><th>Line</th><th>Over</th><th>Under</th><th>Fair</th></tr></thead><tbody>' +
        ou.map((r) => { const x = D.line(r.line); return '<tr><td>' + esc(r.book) + '</td><td>' + r.line + '</td>' + cell(r.over) + cell(r.under) + '<td class="wpb-fair">' + dec2(1 / x.over) + ' / ' + dec2(1 / x.under) + '</td></tr>'; }).join('') +
        '</tbody></table>';
      const lads = L.pr.bets.filter((b) => b.side === 'atleast' && !b.suspect);
      if (lads.length) {
        const byBook = {};
        lads.forEach((b) => { (byBook[b.book] = byBook[b.book] || []).push(b); });
        h += Object.keys(byBook).map((bk) => '<p class="wpb-ladder"><b>' + esc(bk) + ' ladder</b> ' + byBook[bk].sort((x, y) => x.line - y.line).map((b) =>
          '<span class="' + (b.ev > 0 && !b.far ? 'is-pos' : '') + (b.far ? ' is-far' : '') + (b.book === p.book && b.side === p.side && b.line === p.line ? ' is-me' : '') + '" title="fair ' + dec2(1 / b.p) + (b.far ? ', outside the tested range' : '') + '">' + b.line + '+ ' + dec2(b.dec) + '</span>').join('') + '</p>').join('');
      }
      const anc = L.pr.anchor;
      if (anc.L && anc.L.open && anc.L.open.line != null && (anc.L.open.line !== anc.line || Math.abs((anc.L.open.over || 0) - anc.L.over) > 0.04)) {
        h += '<p class="wpb-note">DraftKings opened at ' + anc.L.open.line + ' (' + dec2(anc.L.open.over) + ' / ' + dec2(anc.L.open.under) + '), now ' + anc.line + ' (' + dec2(anc.L.over) + ' / ' + dec2(anc.L.under) + ').</p>';
      }
      h += '<p class="wpb-note">Bet ' + esc(sideText(p)) + ' at another book only at ' + dec2(1.03 / p.p) + ' or more (a 3% edge).</p>';
      return h;
    }

    // Bars for the chance of each total; the bet's side in colour, the line marked.
    function distSVG(L, p) {
      const D = L.pr.dist;
      const lo = Math.max(0, Math.floor(D.mu - 3 * D.sd)), hi = Math.min(D.kMax, Math.ceil(D.mu + 3 * D.sd));
      const n = hi - lo + 1, W = 320, H = 96, bw = W / n;
      let max = 0;
      for (let k = lo; k <= hi; k++) max = Math.max(max, D.pmf[k]);
      const cut = p.side === 'atleast' ? p.line - 0.5 : p.line;
      const win = (k) => (p.side === 'under' ? k < cut : k > cut);
      let bars = '';
      for (let k = lo; k <= hi; k++) {
        const h = (D.pmf[k] / max) * (H - 18);
        bars += '<rect x="' + ((k - lo) * bw + 0.5).toFixed(1) + '" y="' + (H - 14 - h).toFixed(1) + '" width="' + Math.max(1, bw - 1).toFixed(1) + '" height="' + h.toFixed(1) + '" class="' + (win(k) ? 'wpb-b-win' : 'wpb-b-lose') + '"/>';
      }
      const x = ((cut - lo + 0.5) * bw).toFixed(1);
      const lbl = (k) => '<text x="' + ((k - lo + 0.5) * bw).toFixed(1) + '" y="' + (H - 2) + '" class="wpb-axis">' + k + '</text>';
      return '<svg class="wpb-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Chance of each total; ' + pct(p.p) + ' that ' + sideText(p).toLowerCase() + ' wins') + '">' + bars +
        '<line x1="' + x + '" x2="' + x + '" y1="0" y2="' + (H - 14) + '" class="wpb-mark"/>' + lbl(lo) + lbl(Math.round(D.mu)) + lbl(hi) + '</svg>';
    }

    function lastTenSVG(a, p) {
      const g = a.games;
      if (!g.length) return '<p class="wpb-note">No games this season yet.</p>';
      const cut = p.side === 'atleast' ? p.line - 0.5 : p.line;
      const max = Math.max(cut * 1.4, ...g.map((x) => x.v), 1);
      const W = 320, H = 110, bw = W / 10;
      const y = (v) => (H - 26) - (v / max) * (H - 34);
      const bars = g.map((x, i) => {
        const won = p.side === 'under' ? x.v < cut : x.v > cut;
        return '<rect x="' + (i * bw + 3).toFixed(1) + '" y="' + y(x.v).toFixed(1) + '" width="' + (bw - 6).toFixed(1) + '" height="' + ((H - 26) - y(x.v)).toFixed(1) + '" class="' + (won ? 'wpb-b-win' : 'wpb-b-lose') + '"><title>' + esc(x.date + (x.home ? ' v ' : ' @ ') + x.opp + ': ' + x.v + ' in ' + Math.round(x.min) + ' min') + '</title></rect>' +
          '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (y(x.v) - 3).toFixed(1) + '" class="wpb-val">' + x.v + '</text>' +
          '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (H - 13) + '" class="wpb-axis">' + esc(x.opp) + '</text>' +
          '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (H - 2) + '" class="wpb-axis wpb-axis--min">' + Math.round(x.min) + '′</text>';
      }).join('');
      return '<svg class="wpb-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Last games against the line">' + bars +
        '<line x1="0" x2="' + W + '" y1="' + y(cut).toFixed(1) + '" y2="' + y(cut).toFixed(1) + '" class="wpb-mark wpb-mark--h"/></svg>';
    }

    function hitHTML(a, p) {
      const side = p.side === 'under' ? 'under' : 'over';
      const cell = (t, h) => (h.n ? '<li><b>' + h[side] + '/' + h.n + '</b><span>' + esc(t) + '</span><small>avg ' + n1(h.avg) + '</small></li>' : '');
      return '<ul class="wpb-hits">' + cell('Last 5', a.last5) + cell('Last 10', a.last10) + cell('This season', a.season) + cell('Last season', a.lastSeason) + cell('Against ' + p.entry.ctx.opp, a.vsOpp) + '</ul>' +
        '<p class="wpb-note">Hit rates went ' + (side === 'over' ? 'over' : 'under') + ' the line this often. On their own they lost money in the backtest: small samples, and the line already knows them.</p>';
    }

    function whyHTML(why, side) {
      if (!why.length) return '<p class="wpb-note">Nothing stands out either way.</p>';
      return '<ul class="wpb-why">' + why.slice(0, 6).map((r) => '<li class="' + (r.good ? 'is-for' : 'is-against') + '"><span aria-hidden="true">' + (r.good ? '+' : '−') + '</span>' + esc(r.t) + '</li>').join('') + '</ul>' +
        '<p class="wpb-note">+ helps the ' + side + ', − works against it.</p>';
    }

    function matchupHTML(a, L) {
      const M = B().MARKETS;
      const rows = M[L.m].parts.map((s) => {
        const r = a.ranks[s];
        if (!r) return '';
        const f = r.factor - 1;
        return '<li><span class="wpb-rank' + (r.rank <= 8 ? ' is-soft' : r.rank > r.of - 8 ? ' is-hard' : '') + '">' + B().ordinal(r.rank) + '</span>' +
          esc(L.ctx.opp + ' gives up the ' + B().ordinal(r.rank) + '-most ' + M[s].label.toLowerCase() + ' to ' + B().GROUP_NAME[L.grp] + ' (' + (f >= 0 ? '+' : '−') + Math.abs(f * 100).toFixed(0) + '% against an average defence)') + '</li>';
      }).join('');
      const ctx = L.ctx;
      const extra = [];
      if (ctx.total) extra.push('Game total ' + ctx.total + (root.WPStatFactors && root.WPStatFactors.avgTotal ? ' (usual ' + root.WPStatFactors.avgTotal + ')' : ''));
      if (ctx.spread != null) extra.push(ctx.team + (ctx.spread < 0 ? ' favoured by ' + (-ctx.spread) : ctx.spread > 0 ? ' underdog by ' + ctx.spread : ' even'));
      extra.push(ctx.home ? 'At home' : 'On the road');
      if (ctx.b2b) extra.push('Second night of a back-to-back');
      const w = (a.without || []).map((x) => '<li>Without ' + esc(x.name) + ' (' + x.n + ' games): ' + n1(x.avg) + ' in ' + n1(x.min) + ' min, against ' + n1(x.avgWith) + ' in ' + n1(x.minWith) + ' with him.</li>').join('');
      return (rows ? '<ul class="wpb-ranks">' + rows + '</ul>' : '<p class="wpb-note">No defence numbers for this opponent.</p>') +
        '<p class="wpb-note">' + esc(extra.join(' · ')) + '</p>' +
        (w ? '<h4>Teammates out tonight</h4><ul class="wpb-without">' + w + '</ul>' : '');
    }

    function projHTML(a, L) {
      const pj = L.proj;
      if (!pj) return '<p class="wpb-note">Fewer than 3 games this season: no projection of our own, the market alone.</p>';
      const M = B().MARKETS;
      const f = (x) => '×' + x.toFixed(2);
      const parts = M[L.m].parts.map((s) => {
        const F = pj.factors[s];
        return '<li><b>' + esc(M[s].short) + '</b> ' + n1(pj.rate[s] * 36) + ' per 36 · opponent ' + f(F.opp) + ' · pace ' + f(F.pace) + ' · venue ' + f(F.venue) + (F.b2b !== 1 ? ' · back-to-back ' + f(F.b2b) : '') + '</li>';
      }).join('');
      return '<p class="wpb-proj"><b>' + n1(pj.mu[L.m]) + '</b> projected in ' + n1(pj.min) + ' minutes' + (pj.blow < 0.995 ? ' (blowout risk: ' + Math.round((1 - pj.blow) * 100) + '% fewer)' : '') + '</p>' +
        '<ul class="wpb-parts">' + parts + '</ul>' +
        '<p class="wpb-note">Minutes: ' + n1(a.min5) + ' over the last 5, ' + n1(a.minSeason) + ' this season. Shots: ' + n1(a.fga5) + ' a game over the last 5, ' + n1(a.fgaSeason) + ' this season.</p>';
    }

    /* -------------------------------------------------- check your own price */

    function checkHTML() {
      const players = {};
      S.board.lines.forEach((L) => { players[L.id] = L.name; });
      const ids = Object.keys(players).sort((x, y) => players[x].localeCompare(players[y]));
      if (!S.check.pid || !players[S.check.pid]) S.check.pid = ids[0] || '';
      const opt = (v, l, cur) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>';
      const stats = S.board.lines.filter((L) => L.id === S.check.pid).map((L) => L.m);
      if (stats.indexOf(S.check.m) < 0) S.check.m = stats[0] || 'pts';
      return '<section class="wp-sec wpb-check" aria-labelledby="h-check"><div class="wp-sec-h"><h2 id="h-check">Check a price</h2>' +
        '<p>Any book, any line: Placard, Solverde, ESC Online… Enter what they offer and see the fair odds and what you would expect back.</p></div>' +
        '<form class="wpb-form" data-bform="check" onsubmit="return false">' +
        '<label class="wpb-f"><span>Player</span><select data-bact="c-pid" data-focus="bets-c-pid">' + ids.map((id) => opt(id, players[id], S.check.pid)).join('') + '</select></label>' +
        '<label class="wpb-f"><span>Stat</span><select data-bact="c-m" data-focus="bets-c-m">' + stats.map((m) => opt(m, B().MARKETS[m].label, S.check.m)).join('') + '</select></label>' +
        '<label class="wpb-f"><span>Bet</span><select data-bact="c-side" data-focus="bets-c-side">' + opt('over', 'Over', S.check.side) + opt('under', 'Under', S.check.side) + opt('atleast', 'At least (X+)', S.check.side) + '</select></label>' +
        '<label class="wpb-f wpb-num"><span>Line</span><input inputmode="decimal" data-bact="c-line" data-focus="bets-c-line" value="' + esc(S.check.line) + '" placeholder="24.5"></label>' +
        '<label class="wpb-f wpb-num"><span>Odds</span><input inputmode="decimal" data-bact="c-dec" data-focus="bets-c-dec" value="' + esc(S.check.dec) + '" placeholder="1.85"></label>' +
        '</form><div id="wpb-check-out" class="wpb-checkout" aria-live="polite">' + checkOutHTML() + '</div></section>';
    }

    function checkOutHTML() {
      const L = S.board && S.board.lines.find((x) => x.id === S.check.pid && x.m === S.check.m);
      const line = parseFloat(String(S.check.line).replace(',', '.'));
      let dec = parseFloat(String(S.check.dec).replace(',', '.'));
      if (/^[+-]\d+$/.test(String(S.check.dec).trim())) dec = B().decFromAmerican(S.check.dec);
      if (!L) return '';
      const D = L.pr.dist;
      const main = '<span class="wpb-dim">Fair line ' + n1(L.pr.mu) + ' · DraftKings ' + L.pr.anchor.line + '</span>';
      if (!(line >= 0)) return '<p>' + main + ' Enter the line.</p>';
      let p;
      if (S.check.side === 'atleast') p = D.atLeast(Math.ceil(line));
      else { const r = D.line(line); p = (S.check.side === 'over' ? r.over : r.under) + r.push / 2; }
      const fair = 1 / p;
      if (!(dec > 1)) return '<p>' + main + ' <b>Fair odds ' + dec2(fair) + '</b> (' + pct(p) + '). Enter the book’s odds to see the edge.</p>';
      const e = p * dec - 1;
      return '<p class="' + (e > 0 ? 'is-pos' : 'is-neg') + '"><b>' + (e > 0 ? 'Value: ' : 'No value: ') + evText(e) + '</b> per euro · fair odds ' + dec2(fair) + ' · chance ' + pct(p) +
        (e > 0 ? ' · stake ' + (Math.min(0.025, Math.max(0, B().kelly(p, dec) / 4)) * 100).toFixed(1) + '% of bankroll' : ' · worth it from ' + dec2(1.03 / p)) + '</p><p>' + main + '</p>';
    }

    function footHTML() {
      return '<footer class="wp-colophon wpb-foot"><p><b>How the price is set.</b> DraftKings’ line with its margin taken off, then overs marked down: this season they went over less often than DraftKings priced them (by 2.5 points on points, 3.5 on PRA, 4 on steals). A distribution fitted on 16,146 closing lines turns that into a chance for every line and ladder rung, and rungs far from the line are shown but not ranked. Our own projection moves the price only for rebounds; for every other stat the market alone was better.</p>' +
        '<p><b>What the backtest found.</b> At DraftKings’ closing odds, nothing won: betting on our projections lost 6%, Linemaker’s rule (overs against the 5 weakest defences, unders against the 5 best) lost 6%, and betting overs after 7 hits in 10 lost 11%. So value here is a book paying more than DraftKings’ fair price. Expected value is an average over many bets; any one bet can lose. Bet only what you can afford to lose.</p></footer>';
    }

    /* -------------------------------------------------------- track record */

    const units = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + ' u';
    const euros = (x) => (x >= 0 ? '+' : '−') + '€' + Math.abs(x).toFixed(2);
    const OUTCOME = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void' };

    function recordHTML() {
      if (S.rec.loading && !S.log) return '<div class="wp-loading"><span class="wp-spin wpb-spin" aria-hidden="true"></span><p id="wpb-msg">' + esc(S.rec.msg) + '</p></div>';
      if (S.rec.error && !S.log) {
        return '<div class="wp-panel wp-errorpanel" role="alert"><h2>Could not read the track record</h2><p>' + esc(S.rec.error.message || String(S.rec.error)) + '</p>' +
          '<p class="wp-dim">It lives in data/picks.json and needs the local server (python server.py), restarted once for the new routes.</p>' +
          '<div class="wp-form-actions"><button type="button" class="wp-btn wp-btn--primary" data-bact="retry">Try again</button></div></div>';
      }
      const sum = P().summary(S.log || {});
      const a = sum.all;
      if (!a.n && !sum.placed.n) {
        return '<section class="wp-sec"><div class="wp-empty"><p><b>Nothing logged yet.</b> Every value pick the Bets view shows at Betano or Betclic is logged the moment it appears, with its price then, and graded the day after: open Tonight before the games and come back tomorrow.</p>' +
          '<p>To log every night even when you do not open the page, schedule <code>node tools/picks.js log</code> (see the README).</p></div></section>';
      }
      const tile = (label, big, sub, cls) => '<li class="wpb-tile' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><b>' + big + '</b><small>' + sub + '</small></li>';
      const pm = (x, se) => (x == null ? '–' : evText(x)) + (se != null ? ' ± ' + (196 * se).toFixed(1) + '%' : '');
      const P2 = sum.placed;
      const tiles = '<ul class="wpb-tiles">' +
        tile('Value picks', String(a.n), a.settled + ' settled · ' + a.pending + ' to come' + (a.void ? ' · ' + a.void + ' void' : '')) +
        tile('Record', a.win + '–' + a.loss + (a.push ? '–' + a.push : ''), a.settled ? Math.round(100 * a.win / Math.max(1, a.win + a.loss)) + '% won' : 'no results yet') +
        tile('Profit, 1 unit a pick', a.settled ? units(a.units) : '–', a.settled ? 'return ' + pm(a.roi, a.roiSe) : 'graded the day after', a.settled ? (a.units >= 0 ? 'is-pos' : 'is-neg') : '') +
        tile('Expected', a.settled ? units(a.expected) : '–', a.settled ? 'average edge when logged ' + evText(a.evAvg) : '') +
        tile('Against the closing line', a.clvN ? evText(a.clvAvg) : '–', a.clvN ? 'over ' + a.clvN + ' picks' + (a.clvSe != null ? ', ± ' + (196 * a.clvSe).toFixed(1) + '%' : '') : 'graded the day after', a.clvN ? (a.clvAvg >= 0 ? 'is-pos' : 'is-neg') : '') +
        (P2.n ? tile('Your bets', P2.settled ? euros(P2.profit) : '€' + P2.open.toFixed(2) + ' open', P2.settled ? '€' + P2.staked.toFixed(2) + ' staked · ' + (P2.roi != null ? evText(P2.roi) : '') + (P2.pending ? ' · ' + P2.pending + ' open' : '') : P2.n + ' placed, none settled yet', P2.settled ? (P2.profit >= 0 ? 'is-pos' : 'is-neg') : '') : '') +
        '</ul>';
      const note = '<p class="wpb-note">Results are noisy: at about even odds, 100 bets land anywhere within ±20% of their true return by luck alone. The closing line settles sooner: if DraftKings’ closing price, after the same corrections, still makes a pick worth more than the odds it was logged at, the market moved towards it. A positive average over a few hundred picks is the sign of a real edge.</p>';
      const brk = (title, g, name) => {
        const keys = Object.keys(g).sort((x, y) => g[y].n - g[x].n);
        if (keys.length < 2) return '';
        return '<section class="wpb-block"><h3>' + esc(title) + '</h3><table class="wpb-table"><thead><tr><th></th><th>Picks</th><th>Record</th><th>Profit</th><th>Closing</th></tr></thead><tbody>' +
          keys.map((k) => { const s = g[k]; return '<tr><td>' + esc(name(k)) + '</td><td>' + s.n + '</td><td>' + s.win + '–' + s.loss + '</td><td class="' + (s.units >= 0 ? 'is-pos' : 'is-neg') + '">' + (s.settled ? units(s.units) : '–') + '</td><td>' + (s.clvN ? evText(s.clvAvg) : '–') + '</td></tr>'; }).join('') +
          '</tbody></table></section>';
      };
      const SIDE = { over: 'Overs', under: 'Unders', ladder: 'Ladders (X+)' };
      const breaks = [brk('By book', sum.byBook, (k) => k), brk('By stat', sum.byStat, (k) => B().MARKETS[k] ? B().MARKETS[k].label : k), brk('By bet', sum.bySide, (k) => SIDE[k] || k)].filter(Boolean).join('');
      return '<section class="wp-sec wpb-record" aria-labelledby="h-record"><div class="wp-sec-h"><h2 id="h-record">Track record</h2>' +
        '<p>Every value pick shown at Betano or Betclic, at the price when it first appeared, graded from the box score the day after. Profit counts one unit on every pick; your bets count your stakes.' + (S.rec.loading ? ' <span class="wpb-dim" id="wpb-msg">' + esc(S.rec.msg) + '</span>' : '') + '</p></div>' +
        tiles + seriesSVG(sum.series) + note +
        (breaks ? '<div class="wpb-grid wpb-grid--3">' + breaks + '</div>' : '') +
        '</section>' + recentHTML(sum);
    }

    // Running profit by night against what the edges promised.
    function seriesSVG(series) {
      if (series.length < 2) return '';
      const W = 640, H = 150, pad = 28;
      const vals = series.map((s) => s.units).concat(series.map((s) => s.expected), [0]);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const span = hi - lo || 1;
      const x = (i) => pad + i * (W - pad - 8) / (series.length - 1);
      const y = (v) => 8 + (hi - v) / span * (H - 30);
      const path = (k) => series.map((s, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s[k]).toFixed(1)).join(' ');
      const last = series[series.length - 1];
      return '<figure class="wpb-series"><svg class="wpb-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Profit after ' + series.length + ' nights: ' + units(last.units) + ', expected ' + units(last.expected)) + '">' +
        '<line x1="' + pad + '" x2="' + W + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" class="wpb-zero"/>' +
        '<path d="' + path('expected') + '" class="wpb-line wpb-line--exp"/><path d="' + path('units') + '" class="wpb-line"/>' +
        '<text x="2" y="' + (y(hi) + 4).toFixed(1) + '" class="wpb-axis wpb-axis--l">' + hi.toFixed(1) + '</text><text x="2" y="' + (y(lo) + 4).toFixed(1) + '" class="wpb-axis wpb-axis--l">' + lo.toFixed(1) + '</text>' +
        '<text x="' + x(0).toFixed(1) + '" y="' + (H - 4) + '" class="wpb-axis">' + esc(series[0].date.slice(5)) + '</text><text x="' + x(series.length - 1).toFixed(1) + '" y="' + (H - 4) + '" class="wpb-axis">' + esc(last.date.slice(5)) + '</text>' +
        '</svg><figcaption><span class="wpb-key"></span>Profit, units <span class="wpb-key wpb-key--exp"></span>Expected from the edges when logged</figcaption></figure>';
    }

    function recentHTML(sum) {
      const list = sum.recent.filter((r) => (S.rec.filter === 'placed' ? r.placed && r.placed.stake > 0 : r.flagged));
      const seg = (f, l) => '<button type="button" class="wpb-seg' + (S.rec.filter === f ? ' is-on' : '') + '" data-bact="rec-filter" data-f="' + f + '" aria-pressed="' + (S.rec.filter === f) + '">' + l + '</button>';
      const shown = list.slice(0, S.rec.shown);
      const M = B().MARKETS;
      const row = (r) => {
        const o = r.result ? r.result.outcome : null;
        const u = r.placed && S.rec.filter === 'placed' ? (o ? euros(r.placed.stake * P().units(r, r.placed.dec)) : '€' + r.placed.stake) : o ? units(P().units(r, r.first.dec)) : '';
        return '<tr><td>' + esc(r.date.slice(5)) + '</td><td><b>' + esc(r.name) + '</b><small>' + esc((M[r.m] ? M[r.m].short : r.m) + ' ' + (r.side === 'atleast' ? r.line + '+' : (r.side === 'over' ? 'O ' : 'U ') + r.line)) + ' · ' + esc(r.team) + ' v ' + esc(r.opp) + '</small></td>' +
          '<td>' + esc(r.book) + '<small>' + dec2(r.placed && S.rec.filter === 'placed' ? r.placed.dec : r.first.dec) + ' · ' + evText(r.first.ev || 0) + '</small></td>' +
          '<td>' + (o ? '<span class="wpb-out is-' + o + '">' + OUTCOME[o] + '</span>' + (r.result.v != null ? '<small>' + r.result.v + '</small>' : '') : '<span class="wpb-out">To come</span>') + '</td>' +
          '<td class="' + (o === 'win' ? 'is-pos' : o === 'loss' ? 'is-neg' : '') + '">' + u + '</td>' +
          '<td>' + (r.close && r.close.clv != null ? evText(r.close.clv) : '–') + '</td></tr>';
      };
      return '<section class="wp-sec wpb-recent" aria-labelledby="h-recent"><div class="wp-sec-h wp-sec-h--split"><div><h2 id="h-recent">Picks</h2><p>Newest first. Closing: what the pick was worth at DraftKings’ closing price.</p></div>' +
        '<div class="wpb-days" role="group" aria-label="Which picks">' + seg('value', 'Value picks') + seg('placed', 'Your bets') + '</div></div>' +
        (list.length ? '<div class="wpb-scroll"><table class="wpb-table wpb-rtable"><thead><tr><th>Night</th><th>Bet</th><th>Book · odds · edge</th><th>Result</th><th>' + (S.rec.filter === 'placed' ? 'Profit' : 'Units') + '</th><th>Closing</th></tr></thead><tbody>' + shown.map(row).join('') + '</tbody></table></div>' +
          (list.length > shown.length ? '<div class="wpb-more"><button type="button" class="wp-btn" data-bact="rec-more">Show more</button></div>' : '')
          : '<div class="wp-empty"><p>' + (S.rec.filter === 'placed' ? 'No bets marked as placed yet: open a pick and use “I placed this”.' : 'No value picks logged yet.') + '</p></div>') +
        '</section>';
    }

    /* -------------------------------------------------------------- events */

    function redrawList() {
      const el = document.getElementById('wpb-list');
      if (el) el.innerHTML = listHTML(); else rerender();
    }
    function redrawCheck() {
      const el = document.getElementById('wpb-check-out');
      if (el) el.innerHTML = checkOutHTML();
    }

    function onClick(e) {
      const t = e.target.closest && e.target.closest('[data-bact]');
      if (!t) return false;
      const act = t.dataset.bact;
      if (act === 'day') {
        const changed = S.day !== t.dataset.day;
        if (changed || S.mode !== 'night') {
          S.mode = 'night'; S.day = t.dataset.day; keep();
          if (changed) { S.board = null; S.night = null; }
          rerender(); ensure();
        }
        return true;
      }
      if (act === 'record') { if (S.mode !== 'record') { S.mode = 'record'; keep(); rerender(); ensure(); } return true; }
      if (act === 'rec-filter') { S.rec.filter = t.dataset.f === 'placed' ? 'placed' : 'value'; S.rec.shown = 40; rerender(); return true; }
      if (act === 'rec-more') { S.rec.shown += 40; rerender(); return true; }
      if (act === 'place') {
        const inp = t.parentNode && t.parentNode.querySelector('input[data-bact="stake"]');
        const stake = parseFloat(String((inp && inp.value) || S.stake || '').replace(',', '.'));
        if (!(stake > 0)) { if (inp) { inp.focus(); inp.setAttribute('aria-invalid', 'true'); } return true; }
        S.stake = String(stake); keep();
        setPlaced(t.dataset.key, Math.round(stake * 100) / 100);
        return true;
      }
      if (act === 'unplace') { setPlaced(t.dataset.key, null); return true; }
      if (act === 'retry') { ensure(true); return true; }
      if (act === 'more') { S.shown += PAGE; redrawList(); return true; }
      if (act === 'open') {
        const k = t.dataset.key;
        if (S.open.has(k)) S.open.delete(k); else S.open.add(k);
        redrawList();
        const btn = document.querySelector('[data-bact="open"][data-key="' + (root.CSS && CSS.escape ? CSS.escape(k) : k) + '"]');
        if (btn) btn.focus();
        return true;
      }
      return false;
    }

    function onChange(e) {
      const t = e.target;
      const act = t && t.dataset && t.dataset.bact;
      if (!act) return false;
      if (act.indexOf('f-') === 0) {
        const k = { 'f-book': 'book', 'f-stat': 'stat', 'f-type': 'kind', 'f-chance': 'minP' }[act];
        if (!k) return false;
        S.f[k] = k === 'minP' ? parseFloat(t.value) || 0 : t.value;
        S.shown = PAGE; keep(); redrawList();
        return true;
      }
      if (act === 'c-pid' || act === 'c-m' || act === 'c-side') {
        S.check[{ 'c-pid': 'pid', 'c-m': 'm', 'c-side': 'side' }[act]] = t.value;
        if (act === 'c-pid') { rerender(); return true; }
        redrawCheck();
        return true;
      }
      return false;
    }

    function onInput(e) {
      const t = e.target;
      const act = t && t.dataset && t.dataset.bact;
      if (act === 'q') { S.f.q = t.value; S.shown = PAGE; redrawList(); return true; }
      if (act === 'c-line' || act === 'c-dec') { S.check[act === 'c-line' ? 'line' : 'dec'] = t.value; redrawCheck(); return true; }
      if (act === 'stake') { t.removeAttribute('aria-invalid'); return true; }
      return false;
    }

    return { ensure, html, onClick, onChange, onInput, busy: () => S.loading || S.rec.loading };
  }

  root.WPBetsView = { create };
})(typeof self !== 'undefined' ? self : globalThis);
