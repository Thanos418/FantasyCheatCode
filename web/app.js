/* Week planner UI. One IIFE, renders only inside #app.
   Talks to WPData (espn.js) and WPModel (model.js) through the contracts in SPEC.md. */
(function () {
  'use strict';

  const app = document.getElementById('app');
  if (!app) return;

  /* ------------------------------------------------------------------ helpers */

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const MINUS = '−';
  const f1 = (v) => (isNum(v) ? v.toFixed(1) : '–');
  const sgn1 = (v) => (!isNum(v) ? '–' : v > 0.049 ? '+' + v.toFixed(1) : v < -0.049 ? MINUS + Math.abs(v).toFixed(1) : '0.0');
  const sgnN = (v) => (v > 0 ? '+' + v : v < 0 ? MINUS + Math.abs(v) : '0');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // Tip times: viewer's own time zone. Days stay labelled by ESPN's US Eastern date.
  let fmtTime, fmtLocalDay, fmtEtDay, tzShort = '';
  try {
    fmtTime = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
    fmtLocalDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtEtDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    const part = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    tzShort = part ? part.value : '';
  } catch (e) { /* fall back to Date#toTimeString */ }

  function toMs(v) {
    if (isNum(v)) return v;
    if (typeof v === 'string' && v) { const t = Date.parse(v); return isNaN(t) ? NaN : t; }
    return NaN;
  }
  function tipOf(v) {
    const ms = toMs(v);
    if (!isNum(ms)) return null;
    try { return { time: fmtTime.format(ms), next: fmtLocalDay.format(ms) > fmtEtDay.format(ms) }; }
    catch (e) { return { time: new Date(ms).toTimeString().slice(0, 5), next: false }; }
  }
  const clock = (ms) => { const t = tipOf(ms); return t ? t.time : ''; };

  const SLOT_FALLBACK = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL', 12: 'BN', 13: 'IR' };
  function slotLabel(id) {
    if (id === 12) return 'BN';
    if (id === 13) return 'IR';
    const M = window.WPModel;
    return (M && M.SLOT_NAMES && M.SLOT_NAMES[id]) || SLOT_FALLBACK[id] || '';
  }
  function injuryTag(inj) {
    switch (inj) {
      case 'OUT': return { t: 'OUT', cls: 'bad', tip: 'Out' };
      case 'INJURY_RESERVE': return { t: 'IR', cls: 'bad', tip: 'Injured reserve' };
      case 'SUSPENSION': return { t: 'SUS', cls: 'bad', tip: 'Suspended' };
      case 'DAY_TO_DAY': return { t: 'Q', cls: 'go', tip: 'Day to day' };
      default: return null;
    }
  }
  const initials = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };

  /* -------------------------------------------------------------------- state */

  const S = {
    mode: 'local',
    cfg: null,
    client: null,
    base: null,
    weekIdx: -1,
    vm: null,
    phase: 'boot', // boot | setup | fatal | ready
    loading: false,
    error: null,
    syncedAt: 0,
    token: 0,
    tab: store.get('wp:tab') === 'opp' ? 'opp' : 'me',
    pos: store.get('wp:pos') || 'All',
    expanded: new Set(),
    gridWeek: null,
    gridLeft: 0,
    setup: { message: '', values: {} },
    fatal: null,
  };

  const proTeam = (id) => (S.base && S.base.sched && S.base.sched.teams && S.base.sched.teams[id]) || null;
  const proAbbrev = (id) => { const t = proTeam(id); return t ? t.abbrev : ''; };

  /* ---------------------------------------------------------------- UI pieces */

  const ICON = {
    prev: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    caret: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="wp-spin"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  /* Slot pips: the signature element.
     played = counted so far, proj = projected starter, open = unfilled slot (past: nothing to do). */
  function pipsHTML(day, kind, n, who, opts) {
    opts = opts || {};
    const played = Math.max(0, (day && day.played) || 0);
    const proj = Math.max(0, (day && day.remaining) || 0);
    const open = Math.max(0, n - played - proj);
    let h = '';
    for (let i = 0; i < played; i++) h += '<i class="wp-pip p-played"></i>';
    for (let i = 0; i < proj; i++) h += '<i class="wp-pip p-proj"></i>';
    for (let i = 0; i < open; i++) h += '<i class="wp-pip ' + (kind === 'past' ? 'p-gone' : 'p-open') + '"></i>';
    const parts = [];
    if (played) parts.push(played + ' played');
    if (proj) parts.push(proj + ' projected');
    if (open) parts.push(open + (kind === 'past' ? ' empty' : ' open'));
    return '<span class="wp-pips wp-pips--' + who + (opts.cls ? ' ' + opts.cls : '') + '" role="img" aria-label="' + esc(parts.join(', ') || 'No slots') + '">' + h + '</span>';
  }

  function faceHTML(p) {
    const id = p && p.id;
    const img = id != null
      ? '<img src="https://a.espncdn.com/i/headshots/nba/players/full/' + encodeURIComponent(id) + '.png" alt="" loading="lazy" decoding="async">'
      : '';
    return '<span class="wp-face" aria-hidden="true"><span class="wp-ini">' + esc(initials(p && p.name)) + '</span>' + img + '</span>';
  }

  function loadingHTML(msg) {
    const n = (S.base && S.base.league && S.base.league.starters) || 10;
    let p = '';
    for (let i = 0; i < n; i++) p += '<i class="wp-pip p-load" style="--i:' + i + '"></i>';
    return '<div class="wp-loading" role="status"><span class="wp-pips wp-pips--you wp-pips--lg">' + p + '</span><p>' + esc(msg) + '</p></div>';
  }

  /* ------------------------------------------------------------- setup screen */

  function setupHTML() {
    const v = S.setup.values || {};
    const msg = S.setup.message;
    const val = (k) => (v[k] == null ? '' : esc(v[k]));
    return '' +
      '<main class="wp-wrap wp-wrap--narrow">' +
      '<div class="wp-setup">' +
      '<h1 class="wp-setup-title">Connect your ESPN league</h1>' +
      '<p class="wp-lede">Week planner reads your league from ESPN using your own login cookies. They are saved in <code>config.json</code> next to the server and never leave this computer.</p>' +
      (msg ? '<p class="wp-alert" role="alert">' + esc(msg) + '</p>' : '') +
      '<form class="wp-form" data-form="setup" autocomplete="off">' +
      '<label class="wp-field"><span>League link or ID</span>' +
      '<input name="league" type="text" required spellcheck="false" placeholder="https://fantasy.espn.com/basketball/league?leagueId=1257343892" value="' + val('league') + '"></label>' +
      '<div class="wp-field-row">' +
      '<label class="wp-field"><span>Season</span><input name="season" type="number" inputmode="numeric" placeholder="2027" value="' + val('season') + '"></label>' +
      '<label class="wp-field"><span>Your team ID <em>optional</em></span><input name="teamId" type="number" inputmode="numeric" placeholder="Found from your SWID" value="' + val('teamId') + '"></label>' +
      '</div>' +
      '<label class="wp-field"><span>espn_s2 cookie</span><input name="espn_s2" type="password" required spellcheck="false" autocomplete="off" placeholder="Paste the long value as it appears in the cookie"></label>' +
      '<label class="wp-field"><span>SWID cookie</span><input name="swid" type="text" required spellcheck="false" autocomplete="off" placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" value="' + val('swid') + '"></label>' +
      '<div class="wp-form-actions"><button type="submit" class="wp-btn wp-btn--primary">Save and load league</button></div>' +
      '</form>' +
      '<details class="wp-how"><summary>Where do I find the cookies?</summary>' +
      '<ol>' +
      '<li>Open <strong>fantasy.espn.com/basketball</strong> in Chrome or Edge while signed in to ESPN.</li>' +
      '<li>Open developer tools (F12 on Windows, Option+Command+I on a Mac) and go to the Application tab.</li>' +
      '<li>Under Cookies, pick fantasy.espn.com and copy the values of <strong>espn_s2</strong> and <strong>SWID</strong>.</li>' +
      '</ol>' +
      '<p>The cookies expire after a while. When ESPN stops answering, repeat these steps and save again.</p>' +
      '</details>' +
      '</div></main>';
  }

  /* --------------------------------------------------------------- top / hero */

  function weekNote(w) {
    if (!w || !w.long) return '';
    const n = Math.round(w.sps.length / 7);
    return w.playoff ? n + '-week round' : n + '-week matchup (All-Star break)';
  }

  function topHTML() {
    const b = S.base;
    if (!b) return '';
    const weeks = b.weeks;
    const i = S.weekIdx;
    const w = weeks[i];
    if (!w) return '';
    const opts = weeks.map((x, k) => '<option value="' + k + '"' + (k === i ? ' selected' : '') + '>' + esc(x.label) + ' · ' + esc(x.range) + '</option>').join('');
    const note = weekNote(w);
    const synced = S.syncedAt ? 'Synced ' + esc(clock(S.syncedAt)) : '';
    return '' +
      '<div class="wp-top">' +
      '<div class="wp-pager" role="group" aria-label="Week">' +
      '<button type="button" class="wp-iconbtn" data-act="prev" data-focus="prev" aria-label="Previous week"' + (i <= 0 ? ' disabled' : '') + '>' + ICON.prev + '</button>' +
      '<label class="wp-weekpick">' +
      '<span class="wp-weektitle">' + esc(w.label) + ' · ' + esc(w.range) + '</span>' + ICON.caret +
      '<select data-act="week" data-focus="week" aria-label="Choose week">' + opts + '</select>' +
      '</label>' +
      '<button type="button" class="wp-iconbtn" data-act="next" data-focus="next" aria-label="Next week"' + (i >= weeks.length - 1 ? ' disabled' : '') + '>' + ICON.next + '</button>' +
      '</div>' +
      '<div class="wp-sync">' +
      (S.mode === 'demo' ? '<span class="wp-tag wp-tag--demo" title="Fake ESPN data, nothing is read from your league">Demo data</span>' : '') +
      (b.league && b.league.name ? '<span class="wp-league">' + esc(b.league.name) + '</span>' : '') +
      (synced ? '<span class="wp-synced">' + synced + '</span>' : '') +
      '<button type="button" class="wp-btn wp-btn--quiet' + (S.loading ? ' is-loading' : '') + '" data-act="refresh" data-focus="refresh"' + (S.loading ? ' aria-busy="true"' : '') + '>' + ICON.refresh + '<span>Refresh</span></button>' +
      '</div>' +
      (note ? '<p class="wp-weeknote">' + esc(note) + '</p>' : '') +
      '</div>';
  }

  function verdictText(vm) {
    const me = vm.me, opp = vm.opp;
    if (!opp) return { text: 'No opponent this week. You are projected to score ' + f1(me.projFinal) + '.', cls: '' };
    const done = vm.days.every((d) => d.kind === 'past');
    const cur = me.actual - opp.actual;
    const fin = me.projFinal - opp.projFinal;
    if (done) {
      if (cur > 0) return { text: 'Final. You won by ' + f1(cur) + '.', cls: 'good' };
      if (cur < 0) return { text: 'Final. You lost by ' + f1(-cur) + '.', cls: 'bad' };
      return { text: 'Final. It finished level.', cls: '' };
    }
    const proj = isNum(fin) ? (fin >= 0 ? 'projected to finish ' + f1(fin) + ' ahead' : 'projected to finish ' + f1(-fin) + ' behind') : '';
    const cls = !isNum(fin) ? '' : fin >= 0 ? 'good' : 'bad';
    if (me.actual > 0 || opp.actual > 0) {
      const now = (cur >= 0 ? 'Ahead by ' : 'Behind by ') + f1(Math.abs(cur)) + ' now';
      return { text: proj ? now + ', ' + proj + '.' : now + '.', cls };
    }
    return { text: proj ? 'Projected to finish ' + f1(Math.abs(fin)) + (fin >= 0 ? ' ahead.' : ' behind.') : '', cls };
  }

  function heroBar(me, opp) {
    const seg = [me.actual, me.remProj, opp.remProj, opp.actual].map((x) => (isNum(x) && x > 0 ? x : 0));
    const tot = seg.reduce((a, b) => a + b, 0);
    if (!tot) return '';
    const pct = seg.map((x) => ((x / tot) * 100).toFixed(2));
    return '<div class="wp-bar" role="img" aria-label="Projected finish: ' + esc(f1(me.projFinal)) + ' to ' + esc(f1(opp.projFinal)) + '">' +
      '<i class="b-you" style="width:' + pct[0] + '%"></i><i class="b-you-p" style="width:' + pct[1] + '%"></i>' +
      '<i class="b-opp-p" style="width:' + pct[2] + '%"></i><i class="b-opp" style="width:' + pct[3] + '%"></i></div>' +
      '<p class="wp-bar-key">Solid is scored, light is still projected.</p>';
  }

  function heroHTML(vm) {
    const me = vm.me, opp = vm.opp;
    const v = verdictText(vm);
    return '' +
      '<section class="wp-hero" aria-label="Scoreboard">' +
      '<div class="wp-score">' +
      '<div class="wp-side wp-side--you">' +
      '<h2 class="wp-team">' + esc(me.name) + '</h2>' +
      '<p class="wp-pts">' + f1(me.actual) + '</p>' +
      '<p class="wp-proj">Projected <b>' + f1(me.projFinal) + '</b></p>' +
      '</div>' +
      '<div class="wp-sep" aria-hidden="true">–</div>' +
      (opp
        ? '<div class="wp-side wp-side--opp">' +
          '<h2 class="wp-team">' + esc(opp.name) + '</h2>' +
          '<p class="wp-pts">' + f1(opp.actual) + '</p>' +
          '<p class="wp-proj">Projected <b>' + f1(opp.projFinal) + '</b></p>' +
          '</div>'
        : '<div class="wp-side wp-side--opp"><h2 class="wp-team">Bye week</h2><p class="wp-pts wp-pts--none">–</p></div>') +
      '</div>' +
      (opp ? heroBar(me, opp) : '') +
      (v.text ? '<p class="wp-verdict ' + v.cls + '">' + esc(v.text) + '</p>' : '') +
      '</section>';
  }

  /* -------------------------------------------------------------- games edge */

  const gamesOf = (d) => ((d && d.played) || 0) + ((d && d.remaining) || 0);

  function tileHTML(label, a, b, opp) {
    const diff = opp ? a - b : null;
    const dcls = diff == null ? '' : diff > 0 ? 'good' : diff < 0 ? 'bad' : '';
    return '<div class="wp-tile">' +
      '<p class="wp-tile-l">' + esc(label) + '</p>' +
      '<p class="wp-tile-n"><span class="n-you">' + a + '</span><span class="n-v">v</span><span class="n-opp">' + (opp ? b : '–') + '</span></p>' +
      '<p class="wp-tile-d ' + dcls + '">' + (diff == null ? '&nbsp;' : diff === 0 ? 'Even' : sgnN(diff) + (Math.abs(diff) === 1 ? ' game' : ' games')) + '</p>' +
      '</div>';
  }

  function edgeHTML(vm) {
    const L = S.base.league, me = vm.me, opp = vm.opp;
    const n = L.starters || 10;
    const rows = vm.days.map((d) => {
      const a = me.days[d.sp] || {};
      const b = opp ? opp.days[d.sp] || {} : null;
      return '<li class="wp-erow is-' + d.kind + '">' +
        '<span class="wp-eday"><span>' + esc(d.dow) + '</span> <b>' + esc(d.dom) + '</b></span>' +
        pipsHTML(a, d.kind, n, 'you', { cls: 'wp-pips--me' }) +
        '<span class="wp-ecount"><b class="n-you">' + gamesOf(a) + '</b><i>v</i><b class="n-opp">' + (b ? gamesOf(b) : '–') + '</b></span>' +
        (b ? pipsHTML(b, d.kind, n, 'opp', { cls: 'wp-pips--them' }) : '<span></span>') +
        '</li>';
    }).join('');
    return '' +
      '<section class="wp-sec wp-edge" aria-labelledby="h-edge">' +
      '<div class="wp-sec-h"><h2 id="h-edge">Games edge</h2>' +
      '<p>Starters each side can field a night, up to ' + n + ' slots.</p></div>' +
      '<div class="wp-panel-flat">' +
      '<div class="wp-tiles">' +
      tileHTML('Week total', me.total || 0, opp ? opp.total || 0 : 0, !!opp) +
      tileHTML('Still to play', me.remaining || 0, opp ? opp.remaining || 0 : 0, !!opp) +
      tileHTML('Played so far', me.played || 0, opp ? opp.played || 0 : 0, !!opp) +
      '</div>' +
      '<div class="wp-ehead"><span class="n-you">' + esc(me.name) + '</span><span class="n-opp">' + (opp ? esc(opp.name) : '') + '</span></div>' +
      '<ol class="wp-erows">' + rows + '</ol>' +
      '<p class="wp-legend">' +
      '<span class="lg"><i class="wp-pip p-played"></i>played</span>' +
      '<span class="lg"><i class="wp-pip p-proj"></i>projected</span>' +
      '<span class="lg"><i class="wp-pip p-open"></i>open slot</span>' +
      '</p>' +
      '</div></section>';
  }

  /* --------------------------------------------------------- games per team */

  function teamsHTML(vm) {
    const mine = new Map(), theirs = new Map();
    const tally = (tw, map) => {
      if (!tw) return;
      tw.rows.forEach((r) => {
        if (r.gone || !r.player || r.player.slot === 13) return;
        map.set(r.player.proTeamId, (map.get(r.player.proTeamId) || 0) + 1);
      });
    };
    tally(vm.me, mine);
    tally(vm.opp, theirs);
    const groups = (vm.gamesPerTeam || []).map((g) => {
      const chips = g.teams.map((t) => {
        const m = mine.get(t.id) || 0, o = theirs.get(t.id) || 0;
        const cls = m && o ? ' is-both' : m ? ' is-you' : o ? ' is-opp' : '';
        const tip = [m ? plural(m, 'of your players') : '', o ? plural(o, 'of their players') : ''].filter(Boolean).join(', ');
        return '<li class="wp-chip' + cls + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(t.abbrev) + (tip ? '<span class="wp-sr"> (' + esc(tip) + ')</span>' : '') + '</li>';
      }).join('');
      return '<div class="wp-tgroup"><p class="wp-tcount"><b>' + g.count + '</b><span>' + (g.count === 1 ? 'game' : 'games') + '</span></p><ul class="wp-chips">' + chips + '</ul></div>';
    }).join('');
    return '' +
      '<section class="wp-sec wp-teams" aria-labelledby="h-teams">' +
      '<div class="wp-sec-h"><h2 id="h-teams">Games per team</h2>' +
      '<p>Teams with your players are shaded blue, your opponent’s grey.</p></div>' +
      '<div class="wp-tgroups">' + (groups || '<p class="wp-empty">No NBA games are scheduled this week.</p>') + '</div>' +
      '</section>';
  }

  /* -------------------------------------------------------------------- nights */

  function faGamesLeft(fa, fromSp, vm) {
    const sched = S.base.sched;
    const byTeam = (sched.byTeam && sched.byTeam[fa.proTeamId]) || {};
    let n = 0;
    vm.week.sps.forEach((sp) => {
      if (sp < fromSp) return;
      const gid = byTeam[sp];
      if (gid == null) return;
      const g = sched.games && sched.games[gid];
      if (g && isNum(g.date) && g.date <= vm.now) return;
      n++;
    });
    return n;
  }

  function dayLabel(vm, sp) {
    const d = vm.days.find((x) => x.sp === sp);
    return d ? d.dow : '';
  }

  function recMeta(rec) {
    const fa = rec.fa;
    return (fa.pos ? esc(fa.pos) : '') + (fa.pos && proAbbrev(fa.proTeamId) ? ' · ' : '') + esc(proAbbrev(fa.proTeamId));
  }

  function waiverChip(fa) {
    const t = tipOf(fa.waiverDate);
    return '<span class="wp-tag wp-tag--go" title="' + esc('On waivers' + (isNum(fa.waiverDate) ? ', clears ' + new Date(fa.waiverDate).toDateString() : '')) + '">Waivers</span>' + (t ? '' : '');
  }

  function recBodyHTML(rec, vm) {
    const fa = rec.fa;
    const left = Math.max(faGamesLeft(fa, rec.sp, vm), rec.gamesReach || 0);
    const pct = fa.own && isNum(fa.own.pct) ? Math.round(fa.own.pct) + '% rostered' : '';
    const facts = [
      'Starts ' + (rec.gamesReach || 0) + ' of ' + left + (left === 1 ? ' game' : ' games'),
      f1(rec.faProj && rec.faProj.fp) + ' FP a game',
      pct,
    ].filter(Boolean).join(' · ');
    const drop = rec.drop
      ? 'Drop <b>' + esc(rec.drop.last || rec.drop.name) + '</b> <span class="wp-dim">(' + f1(rec.dropProj && rec.dropProj.fp) + ')</span>'
      : 'Open roster spot';
    return '' +
      '<p class="wp-add-n"><strong>' + esc(fa.name) + '</strong> <span class="wp-meta">' + recMeta(rec) + '</span>' + (rec.waiver ? ' ' + waiverChip(fa) : '') + '</p>' +
      '<p class="wp-add-f">' + esc(facts) + '</p>' +
      '<p class="wp-add-d">' + drop + ' <span class="wp-gain ' + (rec.gain > 0 ? 'good' : '') + '">' + sgn1(rec.gain) + ' FP</span>' +
      (rec.upgrade ? '' : ' <span class="wp-dim" title="Per game he is projected below the player he replaces. The gain comes from extra games in your lineup.">not an upgrade</span>') +
      '</p>';
  }

  function nightHTML(vm, d) {
    const L = S.base.league, me = vm.me, opp = vm.opp;
    const n = L.starters || 10;
    const a = me.days[d.sp] || {};
    const b = opp ? opp.days[d.sp] || {} : null;
    const past = d.kind === 'past', today = d.kind === 'today';
    const rosterN = me.rows.filter((r) => !r.gone && r.player && r.player.slot !== 13).length;
    const open = isNum(a.open) ? a.open : Math.max(0, n - gamesOf(a));
    const tip = tipOf(d.firstTip);
    const marker = d.heavy ? '<span class="wp-tag wp-tag--heavy" title="11 or more NBA games">Heavy night</span>' : d.light ? '<span class="wp-tag" title="5 or fewer NBA games">Light night</span>' : '';

    let summary;
    if (past) {
      summary = '<p class="wp-nsum"><b>Played ' + (a.played || 0) + '</b> · ' + f1(a.playedPts) + ' pts</p>' +
        (b ? '<p class="wp-nopp">' + esc(opp.name) + ' ' + (b.played || 0) + ' · ' + f1(b.playedPts) + '</p>' : '');
    } else if (today) {
      summary = '<p class="wp-nsum"><b>' + (a.played || 0) + ' played</b> · ' + (a.remaining || 0) + ' to come' +
        (open > 0 ? ' · <span class="wp-openn">' + open + ' open</span>' : '') + '</p>' +
        (b ? '<p class="wp-nopp">' + esc(opp.name) + ' ' + (b.played || 0) + ' played · ' + (b.remaining || 0) + ' to come</p>' : '');
    } else {
      summary = '<p class="wp-nsum"><b>' + (a.withGame || 0) + ' of ' + rosterN + ' play</b>' +
        (open > 0 ? ' · <span class="wp-openn">' + open + ' open</span>' : ' · lineup full') + '</p>' +
        (b ? '<p class="wp-nopp">' + esc(opp.name) + ' ' + gamesOf(b) + ' starters</p>' : '');
    }

    let addBlock = '';
    if (!past) {
      const recs = (vm.recs && vm.recs.byDay && vm.recs.byDay[d.sp]) || [];
      const adds = vm.adds || {};
      const dayBlocked = today && adds.perDay && adds.limit > 0 && adds.todayUsed >= adds.limit;
      if (recs.length) {
        const alts = recs.slice(1);
        addBlock = '<div class="wp-add' + (dayBlocked ? ' is-blocked' : '') + '"><p class="wp-add-k">Best add</p>' + recBodyHTML(recs[0], vm) + '</div>';
        if (alts.length) {
          addBlock += '<details class="wp-alts"><summary>If not him, ' + alts.length + ' more ' + (alts.length === 1 ? 'option' : 'options') + '</summary><ul>' +
            alts.map((r) => '<li>' + recBodyHTML(r, vm) + '</li>').join('') + '</ul></details>';
        }
      } else if (open > 0 || a.withGame) {
        addBlock = '<p class="wp-add-none">No free agent beats your lineup on this night.</p>';
      }
      if (today && adds.perDay && adds.limit > 0) {
        addBlock += '<p class="wp-lim' + (dayBlocked ? ' is-used' : '') + '">' + (dayBlocked
          ? 'Today’s add is used. Streaming starts tomorrow.'
          : adds.todayUsed + ' of ' + plural(adds.limit, 'add') + ' used today.') + '</p>';
      }
    }

    return '<li class="wp-night is-' + d.kind + (open > 0 && !past ? ' has-open' : '') + '">' +
      '<div class="wp-nhead">' +
      '<h3 class="wp-nday"><span>' + esc(today ? 'Today' : d.dow) + '</span> <b>' + (today ? esc(d.dow) + ' ' : '') + esc(d.dom) + '</b></h3>' +
      '<p class="wp-ngames">' + plural(d.nGames || 0, 'NBA game') + marker + '</p>' +
      '</div>' +
      pipsHTML(a, d.kind, n, 'you', { cls: 'wp-pips--lg' }) +
      summary +
      (tip && !past ? '<p class="wp-ntip">First tip ' + esc(tip.time) + (tip.next ? ' <abbr title="Next calendar day in your time zone">+1</abbr>' : '') + '</p>' : '') +
      addBlock +
      '</li>';
  }

  function addsLine(vm) {
    const a = vm.adds || {};
    const used = a.used || 0;
    let main, pips = '';
    if (isNum(a.weekLimit)) {
      main = used + ' of ' + a.weekLimit + ' adds used this week · ' + Math.max(0, a.weekLimit - used) + ' left';
      if (a.weekLimit <= 14) {
        for (let i = 0; i < a.weekLimit; i++) pips += '<i class="wp-pip ' + (i < used ? 'p-used' : 'p-open') + '"></i>';
        pips = '<span class="wp-pips wp-pips--sm" role="img" aria-label="' + esc(used + ' of ' + a.weekLimit + ' adds used') + '">' + pips + '</span>';
      }
    } else {
      main = plural(used, 'add') + ' used this week';
    }
    const rule = a.limit === -1 ? 'no add limit' : a.perDay && a.limit > 0 ? 'limit ' + a.limit + ' per day' : a.limit > 0 ? 'limit ' + a.limit + ' per week' : '';
    const pending = (a.pending || []).map((p) =>
      '<li>Add <b>' + esc(p.add && p.add.name) + '</b>' + (p.drop ? ', drop <b>' + esc(p.drop.name) + '</b>' : '') + '</li>').join('');
    return '<div class="wp-adds">' + pips + '<p class="wp-adds-t">' + esc(main) + (rule ? ' · ' + esc(rule) : '') + '</p>' +
      (pending ? '<div class="wp-pending"><p>Pending claims</p><ul>' + pending + '</ul></div>' : '') + '</div>';
  }

  function nightsHTML(vm) {
    const note = vm.recs && vm.recs.note;
    return '' +
      '<section class="wp-sec wp-nights" aria-labelledby="h-nights">' +
      '<div class="wp-sec-h wp-sec-h--split"><div><h2 id="h-nights">Nights</h2>' +
      '<p>Orange rings are open lineup slots, the nights where an add pays off. Days follow ESPN’s US Eastern dates; tip times are in your time zone' + (tzShort ? ' (' + esc(tzShort) + ')' : '') + '.</p></div>' +
      addsLine(vm) + '</div>' +
      (note ? '<p class="wp-note">' + esc(note) + '</p>' : '') +
      '<ol class="wp-ngrid">' + vm.days.map((d) => nightHTML(vm, d)).join('') + '</ol>' +
      '</section>';
  }

  /* ------------------------------------------------------------- roster grid */

  const WHY = { bench: 'On your bench, did not count', ir: 'In your IR slot, did not count', away: 'Not on this roster that day' };

  function cellHTML(c, d, row) {
    const tcls = d.kind === 'today' ? ' is-today' : '';
    if (!c) return '<td class="wp-c wp-c--none' + tcls + '"><span aria-label="No game">·</span></td>';
    const opp = c.opp ? (c.home ? '' : '@') + c.opp : '';
    const dayName = d.dow + ' ' + d.dom;
    const tip = tipOf(c.tip);
    const tipTxt = tip ? 'tips ' + tip.time + (tzShort ? ' ' + tzShort : '') : '';
    let main = '', cls = '', title = '', side = '';
    if (c.t === 'played') {
      main = f1(c.fp);
      cls = c.counted ? ' is-counted' : ' is-off';
      const box = c.box;
      const bx = box ? [isNum(box.pts) ? box.pts + ' pts' : '', isNum(box.reb) ? box.reb + ' reb' : '', isNum(box.ast) ? box.ast + ' ast' : '', isNum(box.min) ? box.min + ' min' : ''].filter(Boolean).join(', ') : '';
      title = [dayName, c.home ? 'vs ' + c.opp : '@ ' + c.opp, main + ' FP', bx, c.counted ? '' : WHY[c.why] || 'Did not count', c.live ? 'live' : ''].filter(Boolean).join(' · ');
      if (c.live) side = '<i class="wp-live" title="Game in progress"></i>';
    } else if (c.t === 'dnp') {
      main = c.why === 'out' ? 'OUT' : 'DNP';
      cls = c.why === 'out' ? ' is-out' : ' is-dnp';
      title = [dayName, c.home ? 'vs ' + c.opp : '@ ' + c.opp, c.why === 'out' ? 'Out, did not play' : 'Did not play'].join(' · ');
    } else {
      if (c.out) {
        main = 'OUT'; cls = ' is-out';
        title = [dayName, c.home ? 'vs ' + c.opp : '@ ' + c.opp, 'Ruled out', tipTxt].filter(Boolean).join(' · ');
      } else {
        main = f1(c.fp);
        cls = c.start ? ' is-start' : ' is-squeezed';
        title = [dayName, c.home ? 'vs ' + c.opp : '@ ' + c.opp, 'Projected ' + main + ' FP', c.start ? 'starts' : 'squeezed out, your lineup is full', c.dtd ? 'day to day' : '', tipTxt].filter(Boolean).join(' · ');
        if (c.dtd) side = '<sup class="wp-q" title="Day to day">Q</sup>';
      }
    }
    return '<td class="wp-c' + cls + tcls + '" title="' + esc(title) + '"><span class="wp-fp">' + esc(main) + side + '</span>' + (opp ? '<span class="wp-op">' + esc(opp) + '</span>' : '') + '</td>';
  }

  function rowPlayerHTML(r, key, open) {
    const p = r.player || {};
    const inj = injuryTag(p.injury);
    const slot = r.gone ? '' : slotLabel(p.slot);
    const meta = [proAbbrev(p.proTeamId), p.pos].filter(Boolean).join(' · ');
    return '<th scope="row" class="wp-stick wp-pcell">' +
      '<button type="button" class="wp-pbtn" data-key="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="wp-slot" aria-hidden="true">' + esc(slot) + '</span>' +
      faceHTML(p) +
      '<span class="wp-pname"><span class="wp-pn">' + esc(p.name) + (inj ? ' <span class="wp-inj is-' + inj.cls + '" title="' + esc(inj.tip) + '">' + inj.t + '</span>' : '') + '</span>' +
      '<span class="wp-pm">' + esc(meta) + (slot ? '<span class="wp-pm-slot"> · ' + esc(slot) + '</span>' : '') + '</span></span>' +
      '<span class="wp-wkmini" aria-hidden="true">' + f1(r.total) + '</span>' +
      '</button></th>';
  }

  function gameLogFor(r, vm) {
    const map = new Map();
    const p = r.player || {};
    (p.stats || []).forEach((e) => {
      if (e && e.statSplitTypeId === 5 && e.statSourceId === 0 && isNum(e.scoringPeriodId) && isNum(e.appliedTotal) && e.stats && e.stats['42'] > 0) map.set(e.scoringPeriodId, e.appliedTotal);
    });
    vm.days.forEach((d) => {
      const c = r.cells[d.sp];
      if (c && c.t === 'played' && isNum(c.fp)) map.set(d.sp, c.fp);
    });
    return Array.from(map.entries()).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  }

  function detailHTML(r, vm) {
    const p = r.player || {};
    const pr = r.proj || {};
    const entries = vm.days.map((d) => ({ d, c: r.cells[d.sp] })).filter((x) => x.c);
    const played = entries.filter((x) => x.c.t === 'played' && x.c.counted && isNum(x.c.fp));
    const remStart = entries.filter((x) => x.c.t === 'proj' && x.c.start).length;
    let headline;
    if (r.gone) {
      headline = 'No longer on the roster. ' + f1(r.soFar) + ' FP counted while he was.';
    } else if (played.length) {
      const avg = played.reduce((s, x) => s + x.c.fp, 0) / played.length;
      const pace = avg * (played.length + remStart);
      const diff = pace - r.total;
      headline = 'On pace for <b>' + f1(pace) + '</b> this week, <span class="' + (diff >= 0 ? 'good' : 'bad') + '">' + sgn1(diff) + '</span> vs projection' +
        '<span class="wp-dim"> (after ' + plural(played.length, 'game') + ')</span>';
    } else if (remStart) {
      headline = 'Projected <b>' + f1(r.total) + '</b> this week over ' + plural(remStart, 'game') + '.';
    } else {
      headline = 'No games in a starting slot this week.';
    }

    const own = p.own || {};
    const stat = (k, v, sub) => '<div class="wp-stat"><dt>' + esc(k) + '</dt><dd>' + v + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</dd></div>';
    const stats = '<dl class="wp-stats">' +
      stat('Season', f1(pr.curAvg), isNum(pr.n) && pr.n ? pr.n + ' GP' : '') +
      stat('Last 15', f1(pr.l15), isNum(pr.l15n) && pr.l15n ? pr.l15n + ' GP' : '') +
      stat('ESPN projection', f1(pr.espnProj)) +
      stat('Our projection', f1(pr.fp)) +
      stat('Rostered', isNum(own.pct) ? Math.round(own.pct) + '%' : '–', isNum(own.chg) && Math.abs(own.chg) >= 0.05 ? sgn1(own.chg) : '') +
      '</dl>';

    const log = gameLogFor(r, vm).slice(-4);
    let form = '';
    if (log.length) {
      const mx = Math.max.apply(null, log.concat([1]));
      const ref = isNum(pr.fp) ? pr.fp : 0;
      form = '<div class="wp-form4"><p class="wp-sub">Form, last ' + plural(log.length, 'game') + '</p><ol>' +
        log.map((v) => '<li class="' + (v >= ref ? 'is-hot' : '') + '"><i style="height:' + Math.round(clamp(v / mx, 0.08, 1) * 28) + 'px"></i><span>' + f1(v) + '</span></li>').join('') +
        '</ol></div>';
    }

    const games = entries.filter((x) => x.c.t === 'played' && x.c.box).map((x) => {
      const c = x.c, b = c.box;
      return '<li class="wp-game' + (c.counted ? '' : ' is-off') + '">' +
        '<p class="wp-game-h"><span>' + esc(x.d.dow + ' ' + x.d.dom) + '</span><span>' + esc((c.home ? 'vs ' : '@ ') + c.opp) + '</span></p>' +
        '<p class="wp-game-fp">' + f1(c.fp) + '<small>FP</small></p>' +
        '<dl class="wp-game-l"><div><dt>pts</dt><dd>' + (isNum(b.pts) ? b.pts : '–') + '</dd></div><div><dt>reb</dt><dd>' + (isNum(b.reb) ? b.reb : '–') + '</dd></div><div><dt>ast</dt><dd>' + (isNum(b.ast) ? b.ast : '–') + '</dd></div></dl>' +
        '<p class="wp-game-f">' + [isNum(b.min) ? b.min + ' min' : '', c.counted ? '' : (WHY[c.why] || 'Did not count').split(',')[0]].filter(Boolean).map(esc).join(' · ') + '</p>' +
        '</li>';
    }).join('');

    return '<div class="wp-detail-in">' +
      '<p class="wp-pace">' + headline + '</p>' +
      '<div class="wp-detail-grid">' + stats + form + '</div>' +
      (games ? '<ul class="wp-games">' + games + '</ul>' : '<p class="wp-dim wp-nogames">No games played yet this week.</p>') +
      '</div>';
  }

  function rosterHTML(vm) {
    const L = S.base.league;
    const tab = S.tab === 'opp' && vm.opp ? 'opp' : 'me';
    const tw = tab === 'opp' ? vm.opp : vm.me;
    const colspan = 2 + vm.days.length;
    const head = vm.days.map((d) =>
      '<th scope="col" class="wp-dh is-' + d.kind + (d.kind === 'today' ? ' is-today' : '') + '"><span class="wp-dh-d">' + esc(d.dow) + ' <b>' + esc(d.dom) + '</b></span>' +
      '<span class="wp-dh-g">' + (d.nGames || 0) + (d.light ? ' light' : d.heavy ? ' heavy' : '') + '</span></th>').join('');

    let body = '', lastGrp = 'active';
    tw.rows.forEach((r) => {
      const p = r.player || {};
      const grp = r.gone ? 'gone' : p.slot === 13 ? 'ir' : p.slot === 12 ? 'bench' : 'active';
      if (grp !== lastGrp) {
        const lbl = { bench: 'Bench', ir: 'Injured reserve', gone: 'No longer on this roster' }[grp];
        body += '<tr class="wp-grp"><td colspan="' + colspan + '"><span>' + lbl + '</span></td></tr>';
        lastGrp = grp;
      }
      const key = tab + ':' + p.id;
      const open = S.expanded.has(key);
      const cells = vm.days.map((d) => cellHTML(r.cells[d.sp], d, r)).join('');
      body += '<tr class="wp-row' + (grp === 'active' ? '' : ' is-' + grp) + '" data-key="' + esc(key) + '">' +
        rowPlayerHTML(r, key, open) +
        '<td class="wp-c wp-wk"><span class="wp-fp">' + f1(r.total) + '</span>' + (r.soFar > 0 && r.rest > 0 ? '<span class="wp-op">' + f1(r.soFar) + ' so far</span>' : '') + '</td>' +
        cells + '</tr>' +
        '<tr class="wp-detail" data-key="' + esc(key) + '"' + (open ? '' : ' hidden') + '><td colspan="' + colspan + '">' + detailHTML(r, vm) + '</td></tr>';
    });

    const totals = vm.days.map((d) => {
      const x = (tw.days && tw.days[d.sp]) || {};
      const v = (x.playedPts || 0) + (x.remProj || 0);
      return '<td class="wp-c wp-c--total' + (d.kind === 'today' ? ' is-today' : '') + '"><span class="wp-fp">' + (v > 0 ? f1(v) : '–') + '</span></td>';
    }).join('');

    const tabBtn = (id, label) => '<button type="button" role="tab" class="wp-tab' + (tab === id ? ' is-on' : '') + '" data-act="tab" data-tab="' + id + '" data-focus="tab-' + id + '" aria-selected="' + (tab === id ? 'true' : 'false') + '">' + esc(label) + '</button>';

    return '' +
      '<div class="wp-sec-h wp-sec-h--split"><div><h2 id="h-roster">Roster</h2>' +
      '<p>Real points for finished games, projections for the rest. Pick a player for pace, form and box lines.</p></div>' +
      '<div class="wp-tabs" role="tablist" aria-label="Team">' + tabBtn('me', 'My team') + (vm.opp ? tabBtn('opp', vm.opp.name) : '') + '</div></div>' +
      '<div class="wp-scroll" tabindex="0" role="region" aria-label="' + esc(tw.name) + ' roster by day">' +
      '<table class="wp-table"><thead><tr><th scope="col" class="wp-stick wp-ph">Player</th><th scope="col" class="wp-wk wp-wh">Week</th>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody>' +
      '<tfoot><tr><th scope="row" class="wp-stick wp-ph">Lineup total<span class="wp-wkmini">' + f1(tw.projFinal) + '</span></th>' +
      '<td class="wp-c wp-wk wp-c--total"><span class="wp-fp">' + f1(tw.projFinal) + '</span>' + (tw.actual > 0 && tw.remProj > 0 ? '<span class="wp-op">' + f1(tw.actual) + ' so far</span>' : '') + '</td>' + totals + '</tr></tfoot>' +
      '</table></div>' +
      '<p class="wp-foot">Slots: ' + Object.keys(L.caps || {}).map((k) => (L.caps[k] > 1 ? L.caps[k] + ' ' : '') + slotLabel(+k)).join(', ') + '. Hatched cells are games that do not count: bench, injured reserve, or a full lineup.</p>';
  }

  /* ---------------------------------------------------------------- board */

  const POS_FILTERS = ['All', 'PG', 'SG', 'SF', 'PF', 'C'];

  function boardHTML(vm) {
    const all = (vm.recs && vm.recs.board) || [];
    const pos = POS_FILTERS.indexOf(S.pos) >= 0 ? S.pos : 'All';
    const rows = all.filter((r) => pos === 'All' || String((r.fa && r.fa.pos) || '').split('/').indexOf(pos) >= 0);
    const dayCols = vm.days;
    const pill = (p) => '<button type="button" class="wp-pill' + (pos === p ? ' is-on' : '') + '" data-act="pos" data-pos="' + p + '" data-focus="pos-' + p + '" aria-pressed="' + (pos === p ? 'true' : 'false') + '">' + p + '</button>';

    const head = '<div class="wp-bhead" aria-hidden="true">' +
      '<span class="bh-p">Player</span><span class="bh-o">Rostered</span><span class="bh-f">FP a game</span>' +
      '<span class="bh-d">' + dayCols.map((d) => '<i class="' + (d.kind === 'today' ? 'is-today' : '') + '">' + esc(d.dow.slice(0, 2)) + '</i>').join('') + '</span>' +
      '<span class="bh-x">Best drop</span><span class="bh-g">Gain</span></div>';

    const list = rows.map((r) => {
      const fa = r.fa;
      const own = fa.own || {};
      const chg = isNum(own.chg) && Math.abs(own.chg) >= 0.05 ? '<small class="' + (own.chg > 0 ? 'good' : 'bad') + '">' + sgn1(own.chg) + '</small>' : '';
      const pips = dayCols.map((d) => {
        const st = r.days && r.days[d.sp];
        const t = d.dow + ' ' + d.dom + (st === 'start' ? ': would start' : st === 'squeezed' ? ': game, but lineup is full' : d.kind === 'past' ? ': played' : ': no game');
        const c = st === 'start' ? 'k-start' : st === 'squeezed' ? 'k-squeezed' : d.kind === 'past' ? 'k-past' : 'k-none';
        return '<i class="wp-kp ' + c + (d.kind === 'today' ? ' is-today' : '') + '" title="' + esc(t) + '"></i>';
      }).join('');
      const best = r.bestSp != null ? dayLabel(vm, r.bestSp) : '';
      const abbr = proAbbrev(fa.proTeamId);
      return '<li class="wp-brow">' +
        '<div class="bc-p">' + faceHTML(fa) + '<span class="wp-pname"><span class="wp-pn">' + esc(fa.name) + (fa.status === 'WAIVERS' ? ' ' + waiverChip(fa) : '') + '</span><span class="wp-pm">' + esc([abbr, fa.pos].filter(Boolean).join(' · ')) + '</span></span></div>' +
        '<div class="bc-o"><span>' + (isNum(own.pct) ? Math.round(own.pct) + '%' : '–') + '</span>' + chg + '</div>' +
        '<div class="bc-f">' + f1(r.faProj && r.faProj.fp) + '</div>' +
        '<div class="bc-d" role="img" aria-label="' + esc(plural(r.gamesLeft || 0, 'game') + ' left') + '"><span class="wp-kps">' + pips + '</span><span class="bc-dn">' + (r.gamesLeft || 0) + ' left</span></div>' +
        '<div class="bc-x">' + (r.drop ? 'Drop <b>' + esc(r.drop.last || r.drop.name) + '</b>' : '<span class="wp-dim">Open spot</span>') + '</div>' +
        '<div class="bc-g"><b class="' + (r.gain > 0 ? 'good' : '') + '">' + sgn1(r.gain) + '</b><small>' + (best ? 'from ' + esc(best) : '') + (r.upgrade ? '' : (best ? ' · ' : '') + 'not an upgrade') + '</small></div>' +
        '</li>';
    }).join('');

    let empty = '';
    if (!rows.length) {
      const anyFuture = vm.days.some((d) => d.kind !== 'past');
      if (!anyFuture) empty = '<div class="wp-empty"><p>Every night this week is done, so there is nothing left to stream.</p><button type="button" class="wp-btn" data-act="today">Go to this week</button></div>';
      else if (all.length) empty = '<div class="wp-empty"><p>No ' + esc(pos) + ' in the top ' + all.length + '.</p><button type="button" class="wp-btn" data-act="pos" data-pos="All">Show all positions</button></div>';
      else empty = '<div class="wp-empty"><p>No free agent adds enough games to your lineup this week. Check back after tonight’s games.</p></div>';
    }

    return '' +
      '<div class="wp-sec-h wp-sec-h--split"><div><h2 id="h-board">Streaming board</h2>' +
      '<p>Free agents ranked by points gained over the rest of the week. Orange pips are nights he would start for you.</p></div>' +
      '<div class="wp-pills" role="group" aria-label="Position">' + POS_FILTERS.map(pill).join('') + '</div></div>' +
      (rows.length ? '<div class="wp-board" style="--days:' + dayCols.length + '">' + head + '<ol class="wp-brows">' + list + '</ol></div>' : empty) +
      '<p class="wp-legend wp-legend--board"><span class="lg"><i class="wp-kp k-start"></i>would start</span><span class="lg"><i class="wp-kp k-squeezed"></i>game, lineup full</span><span class="lg"><i class="wp-kp k-none"></i>no game</span></p>';
  }

  function footHTML() {
    return '<footer class="wp-colophon"><p>Projected points blend ESPN’s season projection with this season’s average, weighted by games played. ' +
      'Lineups are optimised against real position eligibility. Data comes from ESPN and refreshes every few minutes.</p></footer>';
  }

  /* --------------------------------------------------------------- rendering */

  function captureFocus() {
    const a = document.activeElement;
    return a && app.contains(a) && a.dataset ? a.dataset.focus || null : null;
  }
  function restoreFocus(k) {
    if (!k) return;
    const el = app.querySelector('[data-focus="' + k + '"]');
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  function renderTop() {
    const el = document.getElementById('wp-top');
    if (!el) return;
    const f = captureFocus();
    el.innerHTML = topHTML();
    restoreFocus(f);
  }

  function renderRoster() {
    const el = document.getElementById('wp-roster');
    if (!el || !S.vm) return;
    const f = captureFocus();
    const sc = el.querySelector('.wp-scroll');
    const left = sc ? sc.scrollLeft : 0;
    el.innerHTML = rosterHTML(S.vm);
    const sc2 = el.querySelector('.wp-scroll');
    if (sc2) sc2.scrollLeft = left;
    watchGrid();
    restoreFocus(f);
  }

  function renderBoard() {
    const el = document.getElementById('wp-board');
    if (!el || !S.vm) return;
    const f = captureFocus();
    el.innerHTML = boardHTML(S.vm);
    restoreFocus(f);
  }

  let ro = null;
  function watchGrid() {
    const sc = app.querySelector('.wp-scroll');
    if (!sc) return;
    const set = () => sc.style.setProperty('--gridw', sc.clientWidth + 'px');
    set();
    if (typeof ResizeObserver === 'function') {
      if (ro) ro.disconnect();
      ro = new ResizeObserver(set);
      ro.observe(sc);
    }
  }

  function alignGrid() {
    const sc = app.querySelector('.wp-scroll');
    if (!sc || !S.vm) return;
    if (S.gridWeek === S.vm.week.id) { sc.scrollLeft = S.gridLeft || 0; return; }
    S.gridWeek = S.vm.week.id;
    const th = sc.querySelector('th.is-today');
    if (!th || sc.scrollWidth <= sc.clientWidth) { sc.scrollLeft = 0; return; }
    let frozen = 0;
    sc.querySelectorAll('thead th.wp-stick, thead th.wp-wk').forEach((x) => { frozen += x.offsetWidth; });
    const want = th.offsetLeft - frozen;
    if (th.offsetLeft + th.offsetWidth > sc.clientWidth + sc.scrollLeft) sc.scrollLeft = Math.max(0, want);
  }

  function bodyHTML() {
    if (S.error && !S.vm) return errorHTML(S.error);
    if (!S.vm) return loadingHTML('Loading ' + ((S.base && S.base.weeks[S.weekIdx] && S.base.weeks[S.weekIdx].label) || 'week') + '…');
    const vm = S.vm;
    return heroHTML(vm) +
      '<div class="wp-pair">' + edgeHTML(vm) + teamsHTML(vm) + '</div>' +
      nightsHTML(vm) +
      '<section class="wp-sec wp-roster" id="wp-roster" aria-labelledby="h-roster">' + rosterHTML(vm) + '</section>' +
      '<section class="wp-sec wp-boardsec" id="wp-board" aria-labelledby="h-board">' + boardHTML(vm) + '</section>' +
      footHTML();
  }

  function errorHTML(err) {
    const msg = (err && err.message) || String(err || 'Unknown error');
    return '<div class="wp-panel wp-errorpanel" role="alert"><h2>Could not load this week</h2>' +
      '<p>' + esc(msg) + '</p><p class="wp-dim">Check your connection and that the server is still running, then try again.</p>' +
      '<div class="wp-form-actions"><button type="button" class="wp-btn wp-btn--primary" data-act="retry">Try again</button></div></div>';
  }

  function renderBody() {
    const el = document.getElementById('wp-body');
    if (!el) return;
    const f = captureFocus();
    const y = window.scrollY;
    if (S.vm && S.gridWeek === S.vm.week.id) {
      const sc = el.querySelector('.wp-scroll');
      if (sc) S.gridLeft = sc.scrollLeft;
    }
    el.classList.toggle('is-busy', !!(S.loading && S.vm));
    el.innerHTML = bodyHTML();
    watchGrid();
    alignGrid();
    restoreFocus(f);
    if (S.vm && y) window.scrollTo(0, y);
    if (S.vm && S.base) {
      const w = S.base.weeks[S.weekIdx];
      document.title = (w ? w.label + ' · ' : '') + 'Week planner';
    }
  }

  function renderShell() {
    app.innerHTML = '<main class="wp-wrap"><h1 class="wp-sr">Week planner</h1><div id="wp-top"></div><div id="wp-body"></div></main>';
    renderTop();
    renderBody();
  }

  function render() {
    if (S.phase === 'boot') {
      app.innerHTML = '<main class="wp-wrap wp-wrap--narrow">' + loadingHTML('Loading your league…') + '</main>';
    } else if (S.phase === 'setup') {
      app.innerHTML = setupHTML();
      const first = app.querySelector('input[name="espn_s2"]') || app.querySelector('input');
      if (first && S.setup.message) first.focus();
    } else if (S.phase === 'fatal') {
      const e = S.fatal;
      app.innerHTML = '<main class="wp-wrap wp-wrap--narrow"><div class="wp-panel wp-errorpanel" role="alert"><h1 class="wp-setup-title">' + esc((e && e.title) || 'Could not load your league') + '</h1>' +
        '<p>' + esc((e && e.message) || '') + '</p>' +
        '<div class="wp-form-actions"><button type="button" class="wp-btn wp-btn--primary" data-act="boot">Try again</button>' +
        (S.mode === 'local' ? '<button type="button" class="wp-btn" data-act="setup">Change ESPN settings</button>' : '') + '</div></div></main>';
    } else {
      renderShell();
    }
  }

  /* -------------------------------------------------------------- data flow */

  function pickWeekIndex(base) {
    const L = base.league;
    const weeks = base.weeks || [];
    let i = weeks.findIndex((w) => (w.sps || []).indexOf(L.currentSp) >= 0);
    if (i < 0) i = weeks.findIndex((w) => w.id === L.currentMp);
    if (i < 0) i = weeks.findIndex((w) => w.last >= L.currentSp);
    if (i < 0) i = weeks.length - 1;
    return Math.max(0, i);
  }

  function isAuth(err) { return err && (err.status === 401 || err.status === 403); }

  function goSetup(message, cfg) {
    const c = cfg || S.cfg || {};
    S.setup = { message: message || '', values: { league: c.leagueId || '', season: c.season || '', teamId: c.teamId || '', swid: c.swid || '' } };
    S.phase = 'setup';
    render();
  }

  function handleLoadError(err) {
    if (S.mode === 'local' && isAuth(err)) {
      goSetup(err.message || 'ESPN rejected the saved cookies. Copy fresh ones from your browser and save them below.');
      return true;
    }
    return false;
  }

  async function loadWeekAt(idx, opts) {
    const silent = !!(opts && opts.silent);
    const my = ++S.token;
    S.weekIdx = idx;
    S.error = null;
    S.loading = true;
    if (!silent) S.vm = null;
    renderTop();
    renderBody();
    try {
      const week = S.base.weeks[idx];
      const ctx = await S.client.loadWeek(S.base, week);
      if (my !== S.token) return;
      const vm = window.WPModel.computeWeek(ctx);
      if (my !== S.token) return;
      S.vm = vm;
      S.syncedAt = Date.now();
      S.loading = false;
    } catch (err) {
      if (my !== S.token) return;
      S.loading = false;
      if (handleLoadError(err)) return;
      if (silent && S.vm) { S.error = null; } else { S.error = err; S.vm = null; }
      if (window.console) console.error(err);
    }
    renderTop();
    renderBody();
  }

  async function boot() {
    S.phase = 'boot';
    render();
    try {
      if (!window.WPData || !window.WPModel) throw new Error('model.js or espn.js did not load. Make sure both files sit next to index.html, then reload.');
      const q = new URLSearchParams(window.location.search);
      S.mode = window.WP_DIRECT ? 'direct' : q.has('demo') ? 'demo' : 'local';
      let cfg;
      if (S.mode === 'direct') cfg = window.WP_DIRECT;
      else if (S.mode === 'demo') {
        if (!window.WPDemo) throw new Error('demo-data.js did not load, so demo mode has nothing to show.');
        cfg = window.WPDemo.config;
      } else {
        const res = await fetch('/config', { cache: 'no-store' });
        if (!res.ok) throw new Error('The local server answered ' + res.status + ' for /config. Start it with start.bat or start.sh and reload this page.');
        cfg = await res.json();
        if (!cfg.configured) { S.cfg = cfg; goSetup('', cfg); return; }
      }
      S.cfg = cfg;
      S.client = window.WPData.create({ mode: S.mode, leagueId: cfg.leagueId, season: cfg.season, teamId: cfg.teamId || undefined, swid: cfg.swid || undefined });
      S.base = await S.client.loadBase();
      S.phase = 'ready';
      S.weekIdx = pickWeekIndex(S.base);
      render();
      await loadWeekAt(S.weekIdx);
    } catch (err) {
      if (window.console) console.error(err);
      if (handleLoadError(err)) return;
      let message = (err && err.message) || String(err);
      if (S.mode === 'direct' && isAuth(err)) message = 'ESPN did not accept this browser session. Sign in to ESPN in this browser and reload.';
      if (S.mode === 'local' && err instanceof TypeError) message = 'Could not reach the local server. Start it with start.bat or start.sh, then reload this page.';
      S.fatal = { title: 'Could not load your league', message };
      S.phase = 'fatal';
      render();
    }
  }

  async function refresh(silent) {
    if (S.phase !== 'ready' || S.loading) return;
    const wid = S.base.weeks[S.weekIdx] && S.base.weeks[S.weekIdx].id;
    S.loading = true;
    renderTop();
    try {
      if (S.client && typeof S.client.clearCache === 'function') S.client.clearCache();
      S.base = await S.client.loadBase();
    } catch (err) {
      S.loading = false;
      if (handleLoadError(err)) return;
      if (window.console) console.error(err);
    }
    S.loading = false;
    let idx = S.base.weeks.findIndex((w) => w.id === wid);
    if (idx < 0) idx = pickWeekIndex(S.base);
    await loadWeekAt(idx, { silent: !!silent || !!S.vm });
  }

  function go(delta) {
    if (S.phase !== 'ready') return;
    const i = clamp(S.weekIdx + delta, 0, S.base.weeks.length - 1);
    if (i === S.weekIdx) return;
    loadWeekAt(i);
  }

  function weekHasToday() { return !!(S.vm && S.vm.days.some((d) => d.kind === 'today')); }

  setInterval(() => {
    if (S.phase !== 'ready' || S.loading || document.visibilityState !== 'visible') return;
    if (weekHasToday() && Date.now() - S.syncedAt >= 5 * 60 * 1000) refresh(true);
  }, 30 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.phase === 'ready' && !S.loading && weekHasToday() && Date.now() - S.syncedAt >= 5 * 60 * 1000) refresh(true);
  });

  /* ------------------------------------------------------------------ events */

  function toggleRow(key) {
    const open = !S.expanded.has(key);
    if (open) S.expanded.add(key); else S.expanded.delete(key);
    app.querySelectorAll('tr.wp-detail').forEach((tr) => { if (tr.dataset.key === key) tr.hidden = !open; });
    app.querySelectorAll('button.wp-pbtn').forEach((b) => { if (b.dataset.key === key) b.setAttribute('aria-expanded', open ? 'true' : 'false'); });
  }

  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (t && app.contains(t)) {
      const act = t.dataset.act;
      if (act === 'prev') return go(-1);
      if (act === 'next') return go(1);
      if (act === 'refresh') return refresh(false);
      if (act === 'retry') return S.base ? loadWeekAt(S.weekIdx) : boot();
      if (act === 'boot') return boot();
      if (act === 'setup') return goSetup('', S.cfg);
      if (act === 'today') { const i = pickWeekIndex(S.base); return loadWeekAt(i); }
      if (act === 'tab') { S.tab = t.dataset.tab === 'opp' ? 'opp' : 'me'; store.set('wp:tab', S.tab); return renderRoster(); }
      if (act === 'pos') { S.pos = t.dataset.pos || 'All'; store.set('wp:pos', S.pos); return renderBoard(); }
    }
    const row = e.target.closest('tr.wp-row');
    if (row && app.contains(row)) toggleRow(row.dataset.key);
  });

  app.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('select[data-act="week"]')) loadWeekAt(clamp(parseInt(t.value, 10) || 0, 0, S.base.weeks.length - 1));
  });

  app.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form="setup"]');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    const v = (k) => String(fd.get(k) || '').trim();
    const payload = { league: v('league'), espn_s2: v('espn_s2'), swid: v('swid') };
    if (v('season')) payload.season = parseInt(v('season'), 10);
    if (v('teamId')) payload.teamId = parseInt(v('teamId'), 10);
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const res = await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let data = {};
      try { data = await res.json(); } catch (x) { /* non-JSON error body */ }
      if (!res.ok) throw new Error(data.message || data.error || 'The server refused the settings (' + res.status + '). Check each field and save again.');
      window.location.reload();
    } catch (err) {
      S.setup = { message: (err && err.message) || 'Could not save the settings.', values: { league: payload.league, season: payload.season || '', teamId: payload.teamId || '', swid: payload.swid } };
      render();
    }
  });

  // Headshots: hide the image on error, reveal the initials; hide initials once the image is in.
  app.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.parentNode) img.remove();
  }, true);
  app.addEventListener('load', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.parentNode && img.parentNode.classList.contains('wp-face')) img.parentNode.classList.add('has-img');
  }, true);

  document.addEventListener('keydown', (e) => {
    if (S.phase !== 'ready' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.closest && t.closest('.wp-scroll')))) return;
    e.preventDefault();
    go(e.key === 'ArrowLeft' ? -1 : 1);
  });

  window.WPApp = { state: S, reload: boot, refresh, go, esc };
  boot();
})();
