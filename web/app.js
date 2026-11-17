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
  // "Tue 08:00" in the viewer's own time zone
  function localDayTime(v) {
    const ms = toMs(v);
    if (!isNum(ms)) return '';
    try { return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms) + ' ' + fmtTime.format(ms); }
    catch (e) { return ''; }
  }

  const SLOT_FALLBACK = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL', 12: 'BN', 13: 'IR' };
  function slotLabel(id) {
    if (id === 12) return 'BN';
    if (id === 13) return 'IR';
    const M = window.WPModel;
    return (M && M.SLOT_NAMES && M.SLOT_NAMES[id]) || SLOT_FALLBACK[id] || '';
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? MON[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10)) : '');
  // When ESPN's injury report expects a player back: a weekday inside the loaded week, a date after it,
  // 'season' when the season is over for that player.
  function backLabel(p) {
    const b = p && p.back;
    if (!b) return '';
    if (b.season) return 'season';
    const day = S.view === 'week' && S.vm ? S.vm.days.find((x) => x.sp === b.sp) : null; // league-wide views have no week to name days in
    return day ? day.dow : shortDate(b.date);
  }
  function injuryTag(p) {
    const back = backLabel(p);
    const note = (p && p.news && p.news.note) || '';
    const tip = (what, dated) => [what, dated && back ? (back === 'season' ? 'out for the season' : 'ESPN expects a return ' + back) : '', note].filter(Boolean).join(' · ');
    const dated = (t) => t + (back ? ' · ' + back : '');
    switch (p && p.injury) {
      case 'OUT': return { t: dated('OUT'), cls: 'bad', tip: tip('Out', true) };
      case 'INJURY_RESERVE': return { t: dated('IR'), cls: 'bad', tip: tip('Injured reserve', true) };
      case 'SUSPENSION': return { t: dated('SUS'), cls: 'bad', tip: tip('Suspended', true) };
      case 'DAY_TO_DAY': return { t: 'DTD', cls: 'go', tip: tip('Day to day', false) };
      default: return null;
    }
  }
  const injHTML = (p) => { const inj = injuryTag(p); return inj ? ' <span class="wp-inj is-' + inj.cls + '" title="' + esc(inj.tip) + '">' + esc(inj.t) + '</span>' : ''; };
  const initials = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };

  /* -------------------------------------------------------------------- state */

  // The view lives in the address (#trades), so reload, Back and a bookmark all land on it.
  const VIEW_IDS = ['week', 'playoffs', 'trends', 'trades', 'league'];
  const hashView = () => { const h = String(window.location.hash || '').replace(/^#/, ''); return VIEW_IDS.indexOf(h) >= 0 ? h : null; };
  // auto follows the system setting; light and dark override it (styles.css reads data-theme).
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: 'match system', light: 'light', dark: 'dark' };
  function applyTheme(t) {
    const el = document.documentElement;
    if (t === 'light' || t === 'dark') el.setAttribute('data-theme', t); else el.removeAttribute('data-theme');
  }

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
    // Phase 2 views
    view: hashView() || (VIEW_IDS.indexOf(store.get('wp:view')) >= 0 ? store.get('wp:view') : 'week'),
    theme: THEMES.indexOf(store.get('wp:theme')) >= 0 ? store.get('wp:theme') : 'auto',
    wp: null, // win probability for the loaded week (WPInsights.winProbability)
    plan: null, // the week plan for the loaded week (WPModel.planWeek)
    enter: false, // the next body render is a new week: play the entrance once
    lg: null, // client.loadLeague result, cached until Refresh
    lgLoading: false,
    lgError: null,
    lgToken: 0,
    lgVer: 0,
    memo: {}, // derived league-wide results, cleared whenever lg changes
    trade: { team: null, give: new Set(), get: new Set() },
  };

  applyTheme(S.theme);

  const proTeam = (id) => (S.base && S.base.sched && S.base.sched.teams && S.base.sched.teams[id]) || null;
  const proAbbrev = (id) => { const t = proTeam(id); return t ? t.abbrev : ''; };

  /* ---------------------------------------------------------------- UI pieces */

  const ICON = {
    prev: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    caret: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'theme-auto': '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
    'theme-light': '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    'theme-dark': '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M13 9.6A5.6 5.6 0 0 1 6.4 3 5.6 5.6 0 1 0 13 9.6z" fill="currentColor"/></svg>',
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

  function loadingHTML(msg, small) {
    const n = (S.base && S.base.league && S.base.league.starters) || 10;
    let p = '';
    for (let i = 0; i < n; i++) p += '<i class="wp-pip p-load" style="--i:' + i + '"></i>';
    return '<div class="wp-loading' + (small ? ' wp-loading--sm' : '') + '" role="status"><span class="wp-pips wp-pips--you wp-pips--lg">' + p + '</span><p>' + esc(msg) + '</p></div>';
  }

  // Win chance (WPInsights). Fractions in, whole percents out; the change hides below half a point.
  function winTag(gain) {
    if (!S.wp || !isNum(gain)) return '';
    let d;
    try { d = window.WPInsights.winDelta(S.wp, gain); } catch (e) { return ''; }
    if (!isNum(d)) return '';
    const pct = d * 100;
    if (Math.abs(pct) < 0.5) return '';
    const r = (pct < 0 ? -1 : 1) * Math.round(Math.abs(pct));
    return ' <span class="wp-wd ' + (r > 0 ? 'good' : 'bad') + '" title="Change in your chance to win the week if you make this move">' + sgnN(r) + '% win chance</span>';
  }

  // Win chance as a half dial between the two scores: the blue arc is your share of simulated finishes.
  function gaugeHTML() {
    const w = S.wp;
    if (!w || !w.opp || !isNum(w.pWin)) return '<div class="wp-mid wp-mid--sep" aria-hidden="true">–</div>';
    const pct = clamp(Math.round(w.pWin * 100), 1, 99);
    const len = Math.PI * 54;
    let after = '';
    if (S.plan && S.plan.moves.length) {
      let d = null;
      try { d = window.WPInsights.winDelta(w, S.plan.gain); } catch (e) { d = null; }
      const p2 = isNum(d) ? clamp(Math.round((w.pWin + d) * 100), 1, 99) : null;
      if (p2 != null && p2 !== pct) after = '<p class="wp-gauge-p">' + p2 + '% with your plan</p>';
    }
    return '<div class="wp-mid wp-gauge" title="Your chance to finish ahead, from simulating the rest of the week 5,000 times. A tie counts as half.">' +
      '<svg viewBox="0 0 128 70" aria-hidden="true" focusable="false">' +
      '<path class="g-track" d="M10 64A54 54 0 0 1 118 64"/>' +
      '<path class="g-fill" d="M10 64A54 54 0 0 1 118 64" style="--len:' + len.toFixed(1) + ';--off:' + (len * (1 - pct / 100)).toFixed(1) + '"/>' +
      '<path class="g-tick" d="M64 17v5"/></svg>' +
      '<p class="wp-gauge-n" role="img" aria-label="' + esc('You win ' + pct + '% of simulated finishes') + '"><b>' + pct + '</b><i>%</i></p>' +
      '<p class="wp-gauge-l">win chance</p>' + after + '</div>';
  }

  /* ------------------------------------------------------------- setup screen */

  function setupHTML() {
    const v = S.setup.values || {};
    const msg = S.setup.message;
    const val = (k) => (v[k] == null ? '' : esc(v[k]));
    if (S.setup.add) return addLeagueHTML(msg, val);
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

  // Add another ESPN league. The saved cookies belong to the ESPN account, so they work for it too.
  function addLeagueHTML(msg, val) {
    return '' +
      '<main class="wp-wrap wp-wrap--narrow">' +
      '<div class="wp-setup">' +
      '<h1 class="wp-setup-title">Add a league</h1>' +
      '<p class="wp-lede">Paste the link of another ESPN league you play in. Your saved cookies work for every league on your ESPN account, so there is nothing else to copy.</p>' +
      (msg ? '<p class="wp-alert" role="alert">' + esc(msg) + '</p>' : '') +
      '<form class="wp-form" data-form="setup" autocomplete="off">' +
      '<label class="wp-field"><span>League link or ID</span>' +
      '<input name="league" type="text" required spellcheck="false" placeholder="https://fantasy.espn.com/basketball/league?leagueId=…" value="' + val('league') + '"></label>' +
      '<label class="wp-field"><span>Your team ID <em>optional</em></span><input name="teamId" type="number" inputmode="numeric" placeholder="Found from your SWID" value="' + val('teamId') + '"></label>' +
      '<div class="wp-form-actions"><button type="submit" class="wp-btn wp-btn--primary">Add and open league</button>' +
      '<button type="button" class="wp-btn wp-btn--quiet" data-act="boot">Cancel</button></div>' +
      '</form>' +
      '</div></main>';
  }

  // League picker (local mode): every saved league plus "Add a league".
  function leaguePickHTML(b) {
    const cfg = S.cfg || {};
    const name = (b.league && b.league.name) || 'Your league';
    if (S.mode !== 'local' || !Array.isArray(cfg.leagues)) return '<span class="wp-league">' + esc(name) + '</span>';
    const opts = cfg.leagues.map((l) => '<option value="' + esc(l.leagueId) + '"' + (l.leagueId === cfg.leagueId ? ' selected' : '') + '>' +
      esc(l.leagueId === cfg.leagueId ? name : (l.name || 'League ' + l.leagueId)) + '</option>').join('') +
      '<option value="add">Add a league…</option>';
    return '<label class="wp-leaguepick"><span class="wp-league">' + esc(name) + '</span>' + ICON.caret +
      '<select data-act="league" data-focus="league" aria-label="Choose league">' + opts + '</select></label>';
  }

  async function switchLeague(value) {
    if (value === 'add') { S.setup = { add: true, message: '', values: {} }; S.phase = 'setup'; return render(); }
    try {
      const res = await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league: value }) });
      if (!res.ok) throw new Error('The server refused to switch league (' + res.status + ').');
      window.location.reload();
    } catch (err) {
      S.fatal = { title: 'Could not switch league', message: (err && err.message) || String(err) };
      S.phase = 'fatal';
      render();
    }
  }

  // Remember the league name and the team found from SWID, so the picker and the digest know them.
  function rememberLeague(cfg, base) {
    if (S.mode !== 'local' || !base || !base.league || !Array.isArray(cfg.leagues)) return;
    const entry = cfg.leagues.find((l) => l.leagueId === cfg.leagueId);
    const name = base.league.name || '';
    if (entry && entry.name === name && entry.teamId === base.myTeamId) return;
    if (entry) { entry.name = name; entry.teamId = base.myTeamId; }
    fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league: cfg.leagueId, name, teamId: base.myTeamId }) })
      .catch(() => { /* only a label; the app works without it */ });
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
    const onWeek = S.view === 'week';
    if (onWeek && !w) return '';
    const busy = S.loading || (!onWeek && S.lgLoading);
    const synced = S.syncedAt ? 'Synced ' + esc(clock(S.syncedAt)) : '';
    let left, note = '';
    if (onWeek) {
      const opts = weeks.map((x, k) => '<option value="' + k + '"' + (k === i ? ' selected' : '') + '>' + esc(x.label) + ' · ' + esc(x.range) + '</option>').join('');
      note = weekNote(w);
      left = '<div class="wp-pager" role="group" aria-label="Week">' +
        '<button type="button" class="wp-iconbtn" data-act="prev" data-focus="prev" aria-label="Previous week"' + (i <= 0 ? ' disabled' : '') + '>' + ICON.prev + '</button>' +
        '<label class="wp-weekpick">' +
        '<span class="wp-weektitle">' + esc(w.label) + ' · ' + esc(w.range) + '</span>' + ICON.caret +
        '<select data-act="week" data-focus="week" aria-label="Choose week">' + opts + '</select>' +
        '</label>' +
        '<button type="button" class="wp-iconbtn" data-act="next" data-focus="next" aria-label="Next week"' + (i >= weeks.length - 1 ? ' disabled' : '') + '>' + ICON.next + '</button>' +
        '</div>';
    } else {
      left = '<div class="wp-viewhead">' + leaguePickHTML(b) + '</div>';
    }
    return '' +
      '<div class="wp-top">' +
      left +
      '<div class="wp-sync">' +
      (S.mode === 'demo' ? '<span class="wp-tag wp-tag--demo" title="Fake ESPN data, nothing is read from your league">Demo data</span>' : '') +
      (onWeek ? leaguePickHTML(b) : '') +
      (synced ? '<span class="wp-synced">' + synced + '</span>' : '') +
      '<button type="button" class="wp-iconbtn wp-iconbtn--quiet" data-act="theme" data-focus="theme" title="' + esc('Theme: ' + THEME_LABEL[S.theme]) + '" aria-label="' + esc('Colour theme: ' + THEME_LABEL[S.theme] + '. Change') + '">' + ICON['theme-' + S.theme] + '</button>' +
      '<button type="button" class="wp-btn wp-btn--quiet' + (busy ? ' is-loading' : '') + '" data-act="refresh" data-focus="refresh"' + (busy ? ' aria-busy="true"' : '') + '>' + ICON.refresh + '<span>Refresh</span></button>' +
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

  function sideHTML(t, who) {
    const teams = (S.base.league && S.base.league.teams) || {};
    const rec = teams[t.teamId] && teams[t.teamId].record;
    const played = rec && (rec.wins || rec.losses || rec.ties);
    return '<div class="wp-side wp-side--' + who + '">' +
      '<h2 class="wp-team"><span class="wp-team-n">' + esc(t.name) + '</span>' + (played ? '<span class="wp-rec" title="Season record">' + esc(recText(rec)) + '</span>' : '') + '</h2>' +
      '<p class="wp-pts">' + f1(t.actual) + '</p>' +
      '<p class="wp-proj">Projected <b>' + f1(t.projFinal) + '</b></p>' +
      '</div>';
  }

  function heroHTML(vm) {
    const me = vm.me, opp = vm.opp;
    const v = verdictText(vm);
    return '' +
      '<section class="wp-hero" aria-label="Scoreboard">' +
      '<div class="wp-score">' +
      sideHTML(me, 'you') +
      gaugeHTML() +
      (opp ? sideHTML(opp, 'opp') : '<div class="wp-side wp-side--opp"><h2 class="wp-team"><span class="wp-team-n">Bye week</span></h2><p class="wp-pts wp-pts--none">–</p></div>') +
      '</div>' +
      (opp ? heroBar(me, opp) : '') +
      (v.text ? '<p class="wp-verdict ' + v.cls + '">' + esc(v.text) + '</p>' : '') +
      '</section>';
  }

  /* --------------------------------------------------------------- week plan */

  function dropText(rec) {
    if (rec.drop) return 'Drop <b>' + esc(rec.drop.last || rec.drop.name) + '</b> <span class="wp-dim">' + f1(rec.dropProj && rec.dropProj.fp) + ' a game</span>' + (rec.activate ? ' to make room · uses no add' : '');
    if (rec.irMove) return 'Move <b>' + esc(rec.irMove.last || rec.irMove.name) + '</b> to IR, no drop';
    return 'Open roster spot, no drop';
  }

  // The three numbers every move is judged by: this week, the weeks after it, and their sum.
  function numsHTML(rec) {
    const wk = rec.ltWeeks || 3;
    const cls = (v, min) => (v > min ? 'good' : v < -0.049 ? 'bad' : '');
    const cell = (k, v, c, tip) => '<div title="' + esc(tip) + '"><dt>' + esc(k) + '</dt><dd' + (c ? ' class="' + c + '"' : '') + '>' + sgn1(v) + '</dd></div>';
    return '<dl class="wp-nums">' +
      cell('This week', rec.gain, cls(rec.gain, 0.049), 'Points your lineup gains this week') +
      (isNum(rec.longTerm) ? cell('Next ' + wk + ' wks', rec.longTerm, cls(rec.longTerm, 0.049), 'The pickup against the player dropped, over their real games and opponents in the next ' + wk + ' weeks, allowing for missed games') : '') +
      (isNum(rec.net) ? cell('Total', rec.net, cls(rec.net, 0.5), 'This week plus the next ' + wk + ' weeks') : '') +
      '</dl>';
  }

  function planHTML(vm) {
    const plan = S.plan;
    if (!plan || !vm.days.some((d) => d.kind !== 'past')) return '';
    const wk = (vm.recs && vm.recs.ltWeeks) || 3;
    const head = (text) => '<div class="wp-sec-h"><h2 id="h-plan">Your plan</h2><p>' + text + '</p></div>';
    if (!plan.moves.length) {
      const note = vm.recs && vm.recs.note;
      return '<section class="wp-sec wp-plan" aria-labelledby="h-plan">' + head('The moves worth making this week, each under the day it takes effect.') +
        '<p class="wp-plan-none"><b>Hold.</b> ' + esc(note || 'No pickup this week is worth more than the player it would cost you once the next ' + wk + ' weeks count.') + '</p></section>';
    }
    const steps = plan.moves.map((m) => {
      const d = vm.days.find((x) => x.sp === m.sp) || {};
      const fa = m.fa;
      return '<li class="wp-step' + (d.kind === 'today' ? ' is-today' : '') + '">' +
        '<p class="wp-step-d"><b>' + esc(d.kind === 'today' ? 'Today' : d.dow || '') + '</b><span>' + esc(d.kind === 'today' ? d.dow + ' ' + d.dom : d.dom || '') + (m.waiver ? ' · joins' : '') + '</span></p>' +
        '<div class="wp-step-b">' +
        '<div class="wp-add-n">' + faceHTML(fa) + '<p><span class="wp-step-k">' + (m.activate ? 'Activate from IR' : m.waiver ? 'Claim' : 'Add') + '</span> <strong>' + esc(fa.name) + '</strong>' + injHTML(fa) + (m.waiver ? ' ' + waiverChip(fa) : '') +
        '<span class="wp-meta">' + recMeta(m) + ' · ' + f1(m.faProj && m.faProj.fp) + ' a game</span></p></div>' +
        '<p class="wp-add-d">' + dropText(m) + '</p>' +
        claimNoteHTML(m, vm) +
        '</div>' + numsHTML(m) + '</li>';
    }).join('');
    const proj = plan.vm && plan.vm.me ? plan.vm.me.projFinal : null;
    const total = '<div class="wp-plan-sum"><p class="wp-plan-k">' + plural(plan.moves.length, 'move') + ' together</p>' +
      numsHTML({ gain: plan.gain, longTerm: plan.longTerm, net: plan.net, ltWeeks: wk }) +
      (isNum(proj) ? '<p class="wp-plan-p">Projected finish <span>' + f1(vm.me.projFinal) + '</span> to <b>' + f1(proj) + '</b>' + winTag(plan.gain) + '</p>' : '') + '</div>';
    return '<section class="wp-sec wp-plan" aria-labelledby="h-plan">' +
      head('The moves worth making this week. Each is listed under the day it takes effect, and a waiver claim has to be entered before that. Each one counts on the ones before it, so no player is dropped twice. The plan is remade every time the data refreshes.') +
      '<div class="wp-plan-in"><ol class="wp-steps">' + steps + '</ol>' + total + '</div></section>';
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
        const tip = [m ? m + ' of your players' : '', o ? o + ' of their players' : ''].filter(Boolean).join(', ');
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

  // A waiver claim is entered before waivers clear and processes when they do. The day a move is
  // listed under is the day it takes effect, so a claim says in words when it has to be in.
  function claimNoteHTML(rec, vm) {
    if (!rec.waiver) return '';
    const at = localDayTime(rec.fa.waiverDate);
    const by = at ? at + (tzShort ? ' ' + tzShort : '') : dayLabel(vm, rec.sp) + ' morning';
    const soon = isNum(rec.fa.waiverDate) && rec.fa.waiverDate - vm.now < 24 * 3600 * 1000;
    return '<p class="wp-add-why wp-claim"><b>' + (soon ? 'Enter this claim now, before ' : 'Enter this claim before ') + esc(by) + '.</b> ESPN processes it then, and that is when ' +
      esc(rec.fa.name) + ' joins your roster' + (rec.drop ? ' and ' + esc(rec.drop.name) + ' leaves' : '') + '.</p>'; // full names: two Joneses can be in one move
  }

  function recBodyHTML(rec, vm) {
    const fa = rec.fa;
    const left = Math.max(faGamesLeft(fa, rec.sp, vm), rec.gamesReach || 0);
    const pct = !rec.activate && fa.own && isNum(fa.own.pct) ? Math.round(fa.own.pct) + '% rostered' : '';
    const facts = [
      'Starts ' + (rec.gamesReach || 0) + ' of ' + left + (left === 1 ? ' game' : ' games'),
      f1(rec.faProj && rec.faProj.fp) + ' FP a game',
      pct,
    ].filter(Boolean).join(' · ');
    const win = winTag(rec.gain);
    return '' +
      '<div class="wp-add-n">' + faceHTML(fa) + '<p>' + (rec.activate ? '<span class="wp-step-k">Activate from IR</span> ' : '') + '<strong>' + esc(fa.name) + '</strong>' + injHTML(fa) + (rec.waiver ? ' ' + waiverChip(fa) : '') + '<span class="wp-meta">' + recMeta(rec) + '</span></p></div>' +
      '<p class="wp-add-f">' + esc(facts) + '</p>' +
      '<p class="wp-add-d">' + dropText(rec) +
      (rec.upgrade ? '' : ' <span class="wp-dim" title="Per game the pickup is projected below the player replaced. The gain comes from extra games in your lineup.">· not an upgrade</span>') + '</p>' +
      claimNoteHTML(rec, vm) +
      numsHTML(rec) + (win ? '<p class="wp-add-w">' + win + '</p>' : '');
  }

  // A night already played: one compact tile with both scores.
  function pastNightHTML(vm, d) {
    const me = vm.me, opp = vm.opp, n = S.base.league.starters || 10;
    const a = me.days[d.sp] || {}, b = opp ? opp.days[d.sp] || {} : null;
    const diff = b ? (a.playedPts || 0) - (b.playedPts || 0) : null;
    return '<li class="wp-pnight' + (diff == null ? '' : diff > 0 ? ' is-won' : diff < 0 ? ' is-lost' : '') + '">' +
      '<p class="wp-pnight-d"><span>' + esc(d.dow) + '</span> <b>' + esc(d.dom) + '</b></p>' +
      pipsHTML(a, 'past', n, 'you', { cls: 'wp-pips--sm' }) +
      '<p class="wp-pnight-s"><b>' + f1(a.playedPts) + '</b>' + (b ? '<i>v</i><span>' + f1(b.playedPts) + '</span>' : '') + '</p>' +
      '<p class="wp-pnight-g">' + (a.played || 0) + (b ? ' v ' + (b.played || 0) : '') + ' starters' + (diff ? ' · <span class="' + (diff > 0 ? 'good' : 'bad') + '">' + sgn1(diff) + '</span>' : '') + '</p></li>';
  }

  // Tonight or a night to come. The pickup shown is the plan's move for that night; other nights show
  // what is left once the whole plan is made, which is a hold by construction.
  function nightHTML(vm, d) {
    const L = S.base.league, me = vm.me, opp = vm.opp;
    const n = L.starters || 10;
    const a = me.days[d.sp] || {};
    const b = opp ? opp.days[d.sp] || {} : null;
    const today = d.kind === 'today';
    const rosterN = me.rows.filter((r) => !r.gone && r.player && r.player.slot !== 13 && !(r.player.claimFrom > d.sp) && !(r.leaves <= d.sp)).length; // pending claims applied
    const open = isNum(a.open) ? a.open : Math.max(0, n - gamesOf(a));
    const tip = tipOf(d.firstTip);
    const marker = d.heavy ? '<span class="wp-tag wp-tag--heavy" title="11 or more NBA games">Heavy night</span>' : d.light ? '<span class="wp-tag" title="5 or fewer NBA games">Light night</span>' : '';

    let summary;
    if (today) {
      summary = '<p class="wp-nsum"><b>' + (a.played || 0) + ' played</b> · ' + (a.remaining || 0) + ' to come' +
        (open > 0 ? ' · <span class="wp-openn">' + open + ' open</span>' : '') + '</p>' +
        (b ? '<p class="wp-nopp">' + esc(opp.name) + ' ' + (b.played || 0) + ' played · ' + (b.remaining || 0) + ' to come</p>' : '');
    } else {
      summary = '<p class="wp-nsum"><b>' + (a.withGame || 0) + ' of ' + rosterN + ' play</b>' +
        (open > 0 ? ' · <span class="wp-openn">' + open + ' open</span>' : ' · lineup full') + '</p>' +
        (b ? '<p class="wp-nopp">' + esc(opp.name) + ' ' + gamesOf(b) + ' starters</p>' : '');
    }

    const claimNames = vm.recs && vm.recs.claimDays && vm.recs.claimDays[d.sp];
    const plan = S.plan;
    const moves = plan ? plan.moves.filter((m) => m.sp === d.sp) : []; // more than one only where adds have no daily limit
    const more = (list, label) => (list && list.length
      ? '<details class="wp-alts"><summary>' + label + '</summary><ul>' + list.map((r) => '<li>' + recBodyHTML(r, vm) + '</li>').join('') + '</ul></details>' : '');
    // A claim already entered processes that morning; it does not stop other moves that night.
    let addBlock = claimNames && claimNames.length
      ? '<div class="wp-add is-claim"><p class="wp-add-k">Claim day</p><p class="wp-add-why">Your claim for <b>' +
        claimNames.map((x) => esc(x.name)).join(', ') + '</b> processes ' + (today ? 'this' : 'that') + ' morning. If it goes through, the pickup is in your lineup from that night.</p></div>'
      : '';
    if (moves.length) {
      addBlock += moves.map((move) => '<div class="wp-add is-spend"><p class="wp-add-k">In your plan' +
        (plan.moves.length > 1 ? ' · move ' + (plan.moves.indexOf(move) + 1) + ' of ' + plan.moves.length : '') + '</p>' + recBodyHTML(move, vm) + '</div>' +
        more(move.alts, 'Instead: ' + plural((move.alts || []).length, 'other option'))).join('');
    } else {
      const src = (plan && plan.vm) || vm;
      const recs = (src.recs && src.recs.byDay && src.recs.byDay[d.sp]) || [];
      const top = recs[0];
      if (top && top.worth === false) {
        addBlock += '<div class="wp-add is-hold"><p class="wp-add-k">Hold</p>' +
          '<p class="wp-add-why">Nothing tonight is worth it once the next ' + (top.ltWeeks || 3) + ' weeks count.</p></div>' +
          more(recs, 'For this week only: ' + esc(top.fa.last || top.fa.name) + ' ' + sgn1(top.gain));
      } else if (top) {
        addBlock += '<div class="wp-add"><p class="wp-add-k">Best add</p>' + recBodyHTML(top, vm) + '</div>' +
          more(recs.slice(1), 'Instead: ' + plural(recs.length - 1, 'other option'));
      } else if (!addBlock && (open > 0 || a.withGame)) {
        addBlock = '<p class="wp-add-none">No free agent beats your lineup on this night.</p>';
      }
    }

    return '<li class="wp-night is-' + d.kind + (open > 0 ? ' has-open' : '') + (moves.length ? ' has-move' : '') + '">' +
      '<div class="wp-nhead">' +
      '<h3 class="wp-nday"><span>' + esc(today ? 'Today' : d.dow) + '</span> <b>' + (today ? esc(d.dow) + ' ' : '') + esc(d.dom) + '</b></h3>' +
      '<p class="wp-ngames">' + plural(d.nGames || 0, 'NBA game') + marker + '</p>' +
      '</div>' +
      pipsHTML(a, d.kind, n, 'you', { cls: 'wp-pips--lg' }) +
      summary +
      (tip ? '<p class="wp-ntip">First tip ' + esc(tip.time) + (tip.next ? ' <abbr title="Next calendar day in your time zone">+1</abbr>' : '') + '</p>' : '') +
      addBlock +
      '</li>';
  }

  function addsLine(vm) {
    const a = vm.adds || {};
    const used = a.used || 0;
    let main, pips = '';
    if (isNum(a.weekLimit)) {
      const free = isNum(a.left) ? a.left : Math.max(0, a.weekLimit - used);
      const held = Math.max(0, a.weekLimit - used - free);
      main = used + ' of ' + a.weekLimit + ' adds used this week · ' + free + ' left' + (held ? ' after your pending ' + (held === 1 ? 'claim' : 'claims') : '');
      if (a.weekLimit <= 14) {
        for (let i = 0; i < a.weekLimit; i++) pips += '<i class="wp-pip ' + (i < used ? 'p-used' : 'p-open') + '"></i>';
        pips = '<span class="wp-pips wp-pips--sm" role="img" aria-label="' + esc(used + ' of ' + a.weekLimit + ' adds used') + '">' + pips + '</span>';
      }
    } else {
      main = plural(used, 'add') + ' used this week';
    }
    const rule = a.limit === -1 ? 'no add limit' : isNum(a.weekLimit) ? 'any day' : '';
    const pending = (a.pending || []).map((p) =>
      '<li>Add <b>' + esc(p.add && p.add.name) + '</b>' + (p.drop ? ', drop <b>' + esc(p.drop.name) + '</b>' : '') +
      (p.sp != null && S.vm ? ' <span class="wp-dim">· processes ' + esc(dayLabel(S.vm, p.sp) || 'later') + '</span>' : '') + '</li>').join('');
    return '<div class="wp-adds">' + pips + '<p class="wp-adds-t">' + esc(main) + (rule ? ' · ' + esc(rule) : '') + '</p>' +
      (pending ? '<div class="wp-pending"><p>Pending claims</p><ul>' + pending + '</ul></div>' : '') + '</div>';
  }

  function nightsHTML(vm) {
    const note = vm.recs && vm.recs.note;
    const past = vm.days.filter((d) => d.kind === 'past'), rest = vm.days.filter((d) => d.kind !== 'past');
    return '' +
      '<section class="wp-sec wp-nights" aria-labelledby="h-nights">' +
      '<div class="wp-sec-h wp-sec-h--split"><div><h2 id="h-nights">Nights</h2>' +
      '<p>Orange rings are open lineup slots, the nights where an add pays off. Days follow ESPN’s US Eastern dates; tip times are in your time zone' + (tzShort ? ' (' + esc(tzShort) + ')' : '') + '.</p></div>' +
      addsLine(vm) + '</div>' +
      (note ? '<p class="wp-note">' + esc(note) + '</p>' : '') +
      (past.length ? '<ol class="wp-pastrow" aria-label="Nights already played">' + past.map((d) => pastNightHTML(vm, d)).join('') + '</ol>' : '') +
      (rest.length ? '<ol class="wp-ngrid">' + rest.map((d) => nightHTML(vm, d)).join('') + '</ol>' : '') +
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
        title = [dayName, c.home ? 'vs ' + c.opp : '@ ' + c.opp, 'Projected ' + main + ' FP', c.start ? 'starts' : 'squeezed out, your lineup is full', c.back ? 'expected back from injury, counted at 75%' : '', c.dtd ? 'day to day' : '', c.b2b ? 'second night of a back-to-back, more likely to rest' : '', tipTxt].filter(Boolean).join(' · ');
        if (c.back) side = '<sup class="wp-q" title="Expected back from injury by then, counted at 75%">RTN</sup>';
        else if (c.dtd) side = '<sup class="wp-q" title="Day to day">Q</sup>';
        else if (c.b2b) side = '<sup class="wp-b2b" title="Second night of a back-to-back">B2B</sup>';
      }
    }
    return '<td class="wp-c' + cls + tcls + '" title="' + esc(title) + '"><span class="wp-fp">' + esc(main) + side + '</span>' + (opp ? '<span class="wp-op">' + esc(opp) + '</span>' : '') + '</td>';
  }

  function rowPlayerHTML(r, key, open) {
    const p = r.player || {};
    const slot = r.gone ? '' : slotLabel(p.slot);
    const meta = [proAbbrev(p.proTeamId), p.pos].filter(Boolean).join(' · ');
    return '<th scope="row" class="wp-stick wp-pcell">' +
      '<button type="button" class="wp-pbtn" data-key="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="wp-slot" aria-hidden="true">' + esc(slot) + '</span>' +
      faceHTML(p) +
      '<span class="wp-pname"><span class="wp-pn">' + esc(p.name) + injHTML(p) +
      (p.claimFrom != null && S.vm ? ' <span class="wp-tag wp-tag--go" title="Pending waiver claim">Claim · from ' + esc(dayLabel(S.vm, p.claimFrom)) + '</span>' : '') +
      (r.leaves != null && S.vm ? ' <span class="wp-tag" title="Dropped by your pending claim">Leaves ' + esc(dayLabel(S.vm, r.leaves)) + '</span>' : '') + '</span>' +
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
      stat('Last 15 days', f1(pr.l15), isNum(pr.l15n) && pr.l15n ? pr.l15n + ' GP' : '') +
      stat('ESPN projection', f1(pr.espnProj)) +
      stat('Our projection', f1(pr.fp), isNum(pr.minTrend) && Math.abs(pr.minTrend) >= 0.005 ? (pr.minTrend > 0 ? '+' : MINUS) + Math.round(Math.abs(pr.minTrend) * 100) + '% for minutes' : '') +
      (isNum(pr.mpg) ? stat('Minutes', f1(pr.mpg), isNum(pr.mpgL15) ? f1(pr.mpgL15) + ' lately' : '') : '') +
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

    const inj = injuryTag(p);
    const news = p.news && p.news.note ? '<p class="wp-news">' + (inj ? '<span class="wp-inj is-' + inj.cls + '">' + esc(inj.t) + '</span> ' : '') + esc(p.news.note) + '</p>' : '';
    return '<div class="wp-detail-in">' +
      '<p class="wp-pace">' + headline + '</p>' + news +
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
      '<span class="bh-x">Best drop</span><span class="bh-g">Value</span></div>';

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
        '<div class="bc-p">' + faceHTML(fa) + '<span class="wp-pname"><span class="wp-pn">' + esc(fa.name) + injHTML(fa) + (fa.status === 'WAIVERS' ? ' ' + waiverChip(fa) : '') + '</span><span class="wp-pm">' + esc([abbr, fa.pos].filter(Boolean).join(' · ')) + '</span></span></div>' +
        '<div class="bc-o"><span>' + (isNum(own.pct) ? Math.round(own.pct) + '%' : '–') + '</span>' + chg + '</div>' +
        '<div class="bc-f">' + f1(r.faProj && r.faProj.fp) + '</div>' +
        '<div class="bc-d" role="img" aria-label="' + esc(plural(r.gamesLeft || 0, 'game') + ' left') + '"><span class="wp-kps">' + pips + '</span><span class="bc-dn">' + (r.gamesLeft || 0) + ' left</span></div>' +
        '<div class="bc-x">' + (r.drop ? 'Drop <b>' + esc(r.drop.last || r.drop.name) + '</b>' : r.irMove ? '<b>' + esc(r.irMove.last || r.irMove.name) + '</b> to IR' : '<span class="wp-dim">Open spot</span>') + '</div>' +
        '<div class="bc-g"><b class="' + (isNum(r.net) ? (r.net > 0.5 ? 'good' : 'bad') : (r.gain > 0 ? 'good' : '')) + '">' + sgn1(isNum(r.net) ? r.net : r.gain) + '</b><small>' + sgn1(r.gain) + ' this week' + (isNum(r.longTerm) ? ' · ' + sgn1(r.longTerm) + ' later' : '') + (best ? ' · from ' + esc(best) : '') + '</small>' + winTag(r.gain) + '</div>' +
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
      '<p>Free agents ranked by value: points gained this week plus his real games and opponents against those of the player you drop over the next ' + ((vm.recs && vm.recs.ltWeeks) || 3) + ' weeks. Orange pips are nights he would start for you.</p></div>' +
      '<div class="wp-pills" role="group" aria-label="Position">' + POS_FILTERS.map(pill).join('') + '</div></div>' +
      (rows.length ? '<div class="wp-board" style="--days:' + dayCols.length + '">' + head + '<ol class="wp-brows">' + list + '</ol></div>' : empty) +
      '<p class="wp-legend wp-legend--board"><span class="lg"><i class="wp-kp k-start"></i>would start</span><span class="lg"><i class="wp-kp k-squeezed"></i>game, lineup full</span><span class="lg"><i class="wp-kp k-none"></i>no game</span></p>';
  }

  function footHTML() {
    return '<footer class="wp-colophon"><p>Projected points start from ESPN’s season projection and this season’s games, with recent games and a change in minutes counting more. ' +
      'Each game is adjusted for venue, opponent and back-to-backs. Later weeks allow for missed games, and injured players count from ESPN’s expected return date. ' +
      'Lineups are optimised against real position eligibility. Data comes from ESPN and refreshes every few minutes.</p></footer>';
  }

  /* ---------------------------------------------------------- league-wide views
     Playoffs, Trends, Trades and League read client.loadLeague() and WPInsights. Every WPInsights
     call goes through needInsights() so a missing module shows a message instead of a broken page. */

  const VIEWS = [['week', 'This week'], ['playoffs', 'Playoffs'], ['trends', 'Trends'], ['trades', 'Trades'], ['league', 'League']];

  function viewsHTML() {
    return '<nav class="wp-views" aria-label="View">' + VIEWS.map((v) => {
      const on = S.view === v[0];
      return '<button type="button" class="wp-vbtn' + (on ? ' is-on' : '') + '" data-act="view" data-view="' + v[0] + '" data-focus="view-' + v[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(v[1]) + '</button>';
    }).join('') + '</nav>';
  }

  const factorsFor = (isPoints) => (isPoints && window.WPFactors) || null;

  function needInsights(fn) {
    const I = window.WPInsights;
    if (!I) throw new Error('insights.js did not load. Make sure it sits next to index.html, then reload.');
    if (typeof I[fn] !== 'function') throw new Error('insights.js has no ' + fn + ' yet. Update it and reload.');
    return I;
  }

  function memo(key, build) {
    if (!(key in S.memo)) S.memo[key] = build();
    return S.memo[key];
  }
  function resetDerived() { S.memo = {}; S.lgVer++; }

  const fromSp = () => { const L = S.base.league; return Math.min(L.currentSp, L.finalSp || L.currentSp); };
  const recText = (r) => (r ? r.wins + '–' + r.losses + (r.ties ? '–' + r.ties : '') : '');
  const roundName = (w) => { const s = String((w && w.label) || '').replace(/^Playoffs\s*·\s*/i, ''); return s.charAt(0).toUpperCase() + s.slice(1); };
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function teamName(id) {
    const t = S.base && S.base.league && S.base.league.teams && S.base.league.teams[id];
    return (t && t.name) || 'Team ' + id;
  }

  function myRoster() {
    const r = S.lg && S.lg.rosters && S.lg.rosters[S.base.myTeamId];
    if (r && r.length) return r;
    if (S.vm) return S.vm.me.rows.filter((x) => !x.gone && x.player).map((x) => x.player);
    return [];
  }

  function projFp(p) {
    try {
      const L = S.base.league;
      const pr = window.WPModel.projectPlayer(p, L.season, L.isPoints);
      return pr && isNum(pr.fp) ? pr.fp : null;
    } catch (e) { return null; }
  }

  function secHead(id, title, text) {
    return '<div class="wp-sec-h"><h2 id="' + id + '">' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + '</div>';
  }

  function playerCellHTML(p, extra) {
    const meta = [proAbbrev(p.proTeamId), p.pos, extra].filter(Boolean).join(' · ');
    return '<span class="wp-pc">' + faceHTML(p) + '<span class="wp-pname"><span class="wp-pn">' + esc(p.name) +
      injHTML(p) + '</span>' +
      '<span class="wp-pm">' + esc(meta) + '</span></span></span>';
  }

  function softErrorHTML(title, err) {
    const msg = (err && err.message) || String(err || 'Unknown error');
    return '<div class="wp-panel wp-errorpanel" role="alert"><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p>' +
      '<p class="wp-dim">Reload the page to try again. If it keeps failing, check that insights.js sits next to index.html.</p>' +
      '<div class="wp-form-actions"><button type="button" class="wp-btn wp-btn--primary" data-act="retry-view">Try again</button></div></div>';
  }
  const inlineErrorHTML = (msg) => '<p class="wp-alert" role="alert">' + esc(msg) + '</p>';

  /* ---- Playoffs */

  function gamesCell(n, max) {
    n = n || 0;
    return '<td class="wp-g"><span class="wp-gn' + (!n ? ' is-zero' : max && n >= max ? ' is-max' : '') + '"' + (!n ? ' title="No games"' : '') + '>' + (n || '–') + '</span></td>';
  }

  function playoffTableHTML(list, res, label, withOwn) {
    const weeks = res.weeks || [];
    const max = {};
    weeks.forEach((w) => { max[w.id] = (res.teams || []).reduce((m, t) => Math.max(m, (t.games && t.games[w.id]) || 0), 0); });
    const head = weeks.map((w) => '<th scope="col" class="wp-g">' + esc(roundName(w)) + '<small>' + esc(w.range) + '</small></th>').join('');
    const body = list.map((r) => {
      const p = r.player || {};
      const own = p.own && isNum(p.own.pct) ? Math.round(p.own.pct) + '%' : '–';
      return '<tr><th scope="row" class="wp-stick">' + playerCellHTML(p) + '</th>' +
        weeks.map((w) => gamesCell(r.games && r.games[w.id], max[w.id])).join('') +
        '<td class="wp-g"><b>' + (r.total || 0) + '</b></td><td><b>' + f1(r.expFp) + '</b></td>' + (withOwn ? '<td>' + own + '</td>' : '') + '</tr>';
    }).join('');
    return '<div class="wp-tscroll" tabindex="0" role="region" aria-label="' + esc(label) + '"><table class="wp-dt"><caption class="wp-sr">' + esc(label) + '</caption>' +
      '<thead><tr><th scope="col" class="wp-stick">Player</th>' + head + '<th scope="col" class="wp-g">Games</th><th scope="col">Expected FP</th>' + (withOwn ? '<th scope="col">Rostered</th>' : '') + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
  }

  function playoffsHTML() {
    const L = S.base.league;
    const res = memo('playoffs', () => needInsights('playoffPlanner').playoffPlanner({
      league: L, sched: S.base.sched, weeks: S.base.weeks, factors: factorsFor(L.isPoints), roster: myRoster(), freeAgents: (S.lg && S.lg.freeAgents) || [],
    }));
    const weeks = (res && res.weeks) || [];
    if (!weeks.length) {
      return '<div class="wp-view"><div class="wp-empty"><p>The fantasy playoffs are not on the schedule yet, so there is nothing to plan.</p>' +
        '<button type="button" class="wp-btn" data-act="view" data-view="week">Back to this week</button></div></div>';
    }
    const mine = res.mine || [];
    const mineTeams = new Set(mine.filter((r) => r.player && r.player.slot !== 13).map((r) => r.player.proTeamId));
    const groups = new Map();
    (res.teams || []).forEach((t) => { if (!groups.has(t.total)) groups.set(t.total, []); groups.get(t.total).push(t); });
    const groupHTML = Array.from(groups.keys()).sort((a, b) => b - a).map((total) => {
      const chips = groups.get(total).map((t) => {
        const detail = weeks.map((w) => roundName(w) + ' ' + ((t.games && t.games[w.id]) || 0)).join(', ') + (t.b2b ? ', ' + plural(t.b2b, 'back-to-back') : '');
        return '<li class="wp-chip' + (mineTeams.has(t.proId) ? ' is-you' : '') + '" title="' + esc(detail) + '">' + esc(t.abbrev) +
          (t.b2b ? '<small>' + t.b2b + ' B2B</small>' : '') + '<span class="wp-sr"> (' + esc(detail) + ')</span></li>';
      }).join('');
      return '<div class="wp-tgroup"><p class="wp-tcount"><b>' + total + '</b><span>' + (total === 1 ? 'game' : 'games') + '</span></p><ul class="wp-chips">' + chips + '</ul></div>';
    }).join('');
    const fas = res.fas || [];
    return '<div class="wp-view">' +
      '<div class="wp-pair">' +
      '<section class="wp-sec" aria-labelledby="h-pmine">' +
      secHead('h-pmine', 'Your players', 'Games in each playoff round and expected points after schedule, rest days and back-to-backs. Orange marks the most games any NBA team plays that round.') +
      (mine.length ? playoffTableHTML(mine, res, 'Your players, games by playoff round', false) : '<div class="wp-empty"><p>No roster to plan with yet. Refresh to load it.</p></div>') +
      '</section>' +
      '<section class="wp-sec" aria-labelledby="h-pteams">' +
      secHead('h-pteams', 'NBA teams by games', 'Total games across the playoff rounds. Teams with one of your players are shaded blue. B2B counts second nights of back-to-backs.') +
      '<div class="wp-tgroups">' + (groupHTML || '<p class="wp-empty">No NBA games are scheduled in these rounds.</p>') + '</div>' +
      '</section></div>' +
      '<section class="wp-sec" aria-labelledby="h-pfa">' +
      secHead('h-pfa', 'Free agents to hold for the playoffs', 'Top available players by expected points over all the playoff rounds, ruled-out players skipped.') +
      (fas.length ? playoffTableHTML(fas, res, 'Free agents, games by playoff round', true) : '<div class="wp-empty"><p>No free agents to show. Refresh to load the pool.</p></div>') +
      '</section></div>';
  }

  /* ---- Trends */

  const TREND_TAGS = { rising: ['Rising', 'up'], falling: ['Falling', 'down'] };
  const TREND_ROLES = { 'new starter': ['New starter', 'up'], 'lost start': ['Lost start', 'down'], 'more minutes': ['More minutes', 'up'], 'fewer minutes': ['Fewer minutes', 'down'] };

  function trendChips(r) {
    const out = [];
    const tg = TREND_TAGS[r.tag];
    const ro = TREND_ROLES[r.role];
    if (tg) out.push('<span class="wp-tag wp-tag--' + tg[1] + '" title="' + (r.tag === 'rising' ? 'Last 15 games are well above the usual level' : 'Last 15 games are well below the usual level') + '">' + tg[0] + '</span>');
    if (ro) out.push('<span class="wp-tag wp-tag--' + ro[1] + '" title="' + esc(isNum(r.startRateL15) ? 'Starts ' + Math.round(r.startRateL15 * 100) + '% of games over the last 15' : 'Minutes changed over the last 15') + '">' + ro[0] + '</span>');
    return out.join('');
  }

  const trendBase = (r) => (isNum(r.proj) ? r.proj : r.avg);
  const deltaHTML = (v) => (isNum(v) ? '<span class="' + (v >= 0.05 ? 'good' : v <= -0.05 ? 'bad' : '') + '">' + sgn1(v) + '</span>' : '–');

  function trendTableHTML(rows, label) {
    const body = rows.map((r) => {
      const p = r.player || {};
      const mins = isNum(r.mpgL15) ? r.mpgL15 : r.mpg;
      return '<tr><th scope="row" class="wp-stick">' + playerCellHTML(p) + '</th>' +
        '<td>' + f1(r.avg) + (r.n ? '<small>' + r.n + ' GP</small>' : '') + '</td>' +
        '<td>' + f1(r.l7) + '</td>' +
        '<td>' + f1(r.l15) + (r.n15 ? '<small>' + r.n15 + ' GP</small>' : '') + '</td>' +
        '<td>' + f1(r.proj) + '</td>' +
        '<td class="wp-dl">' + deltaHTML(r.delta) + '</td>' +
        '<td>' + (isNum(mins) ? f1(mins) : '–') + (isNum(r.mpg) && isNum(r.mpgL15) ? '<small>season ' + f1(r.mpg) + '</small>' : '') + '</td>' +
        '<td class="wp-l"><span class="wp-notes">' + trendChips(r) + '</span></td></tr>';
    }).join('');
    return '<div class="wp-tscroll" tabindex="0" role="region" aria-label="' + esc(label) + '"><table class="wp-dt"><caption class="wp-sr">' + esc(label) + '</caption>' +
      '<thead><tr><th scope="col" class="wp-stick">Player</th><th scope="col">Season</th><th scope="col">Last 7</th><th scope="col">Last 15</th><th scope="col">ESPN proj</th><th scope="col">Change</th><th scope="col">Minutes</th><th scope="col" class="wp-l">Notes</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
  }

  function trendItemHTML(r, who) {
    const p = r.player || {};
    const owner = who === 'buy' ? teamName(p.onTeamId) : '';
    return '<li class="wp-trow"><div class="wp-trow-p">' + playerCellHTML(p, owner) + '</div>' +
      '<div class="wp-trow-n"><b>' + f1(r.l15) + '</b><small>last 15 vs ' + f1(trendBase(r)) + '</small></div>' +
      '<div class="wp-trow-t"><span class="wp-dl">' + deltaHTML(r.delta) + '</span>' + trendChips(r) + '</div></li>';
  }

  function trendsHTML() {
    const L = S.base.league, me = S.base.myTeamId;
    const rosters = (S.lg && S.lg.rosters) || {};
    const rows = memo('trends', () => {
      const all = [];
      Object.keys(rosters).forEach((tid) => (rosters[tid] || []).forEach((p) => all.push(p)));
      return needInsights('trends').trends(all, L.season) || [];
    });
    const bl = memo('buysell', () => needInsights('buyLowSellHigh').buyLowSellHigh(rows, me) || { buyLow: [], sellHigh: [] });
    const mineIds = new Set((rosters[me] || []).map((p) => String(p.id)));
    const key = (v) => (isNum(v) ? v : -1);
    const mine = rows.filter((r) => r.player && mineIds.has(String(r.player.id))).sort((a, b) => key(b.avg) - key(a.avg));
    const buy = bl.buyLow || [], sell = bl.sellHigh || [];
    return '<div class="wp-view">' +
      '<section class="wp-sec" aria-labelledby="h-tmine">' +
      secHead('h-tmine', 'Your roster', 'Points per game this season, over the last 7 and 15 days, and against ESPN’s projection. Change is the last 15 days minus the projection (the season average when there is none).') +
      (mine.length ? trendTableHTML(mine, 'Your roster, recent form') : '<div class="wp-empty"><p>No roster to show yet. Refresh to load it.</p></div>') +
      '</section>' +
      '<div class="wp-pair">' +
      '<section class="wp-sec" aria-labelledby="h-buy">' +
      secHead('h-buy', 'Buy low', 'Players on other teams who usually score 25 or more a game but have slumped over the last 15 days. Worth a trade offer.') +
      (buy.length ? '<ul class="wp-tlist">' + buy.map((r) => trendItemHTML(r, 'buy')).join('') + '</ul>' : '<div class="wp-empty"><p>Nobody on another team is in a deep enough slump right now. Check again after more games.</p></div>') +
      '</section>' +
      '<section class="wp-sec" aria-labelledby="h-sell">' +
      secHead('h-sell', 'Sell high', 'Your players running well above their usual level over the last 15 days. Their price may not hold.') +
      (sell.length ? '<ul class="wp-tlist">' + sell.map((r) => trendItemHTML(r, 'sell')).join('') + '</ul>' : '<div class="wp-empty"><p>None of your players is running unusually hot. Nothing to sell yet.</p></div>') +
      '</section></div></div>';
  }

  /* ---- Trades */

  const countText = (n) => (n ? '· ' + n + ' picked' : '');

  function pickItemHTML(p, side, checked) {
    const meta = [proAbbrev(p.proTeamId), p.pos].filter(Boolean).join(' · ');
    const id = esc(p.id);
    return '<li><label class="wp-pick"><input type="checkbox" data-act="trade-pick" data-side="' + side + '" data-id="' + id + '" data-focus="pick-' + side + '-' + id + '"' + (checked ? ' checked' : '') + '>' +
      faceHTML(p) + '<span class="wp-pname"><span class="wp-pn">' + esc(p.name) + injHTML(p) + '</span>' +
      '<span class="wp-pm">' + esc(meta) + '</span></span>' +
      '<span class="wp-pickfp">' + f1(projFp(p)) + '<small>FP a game</small></span></label></li>';
  }

  function pickColHTML(side, title, roster, set) {
    const list = roster.map((p) => ({ p, fp: projFp(p) })).sort((a, b) => (b.fp == null ? -1 : b.fp) - (a.fp == null ? -1 : a.fp));
    return '<section class="wp-pickcol" aria-label="' + esc(title) + '"><h3>' + esc(title) + ' <span class="wp-dim" data-count="' + side + '">' + countText(set.size) + '</span></h3>' +
      '<ul class="wp-picklist">' + list.map((x) => pickItemHTML(x.p, side, set.has(String(x.p.id)))).join('') + '</ul></section>';
  }

  function tradeState() {
    const t = S.trade;
    const rosters = (S.lg && S.lg.rosters) || {};
    if (t.team && !rosters[t.team]) { t.team = null; t.give.clear(); t.get.clear(); }
    return t;
  }

  function tradeResultHTML() {
    const t = tradeState();
    if (!t.team) return '';
    const L = S.base.league, me = S.base.myTeamId, rosters = S.lg.rosters || {};
    const lookup = (list, ids) => list.filter((p) => ids.has(String(p.id))).map((p) => p.id);
    const give = lookup(rosters[me] || [], t.give);
    const get = lookup(rosters[t.team] || [], t.get);
    if (!give.length && !get.length) return '<p class="wp-hint">Tick the players you would give and get to see what the trade does to both lineups.</p>';
    const other = L.teams && L.teams[t.team] ? L.teams[t.team].id : Number(t.team);
    // Main numbers use the next 4 weeks, the same window as the trade ideas; rest of season is a second line.
    let res, ros;
    try {
      const args = {
        league: L, sched: S.base.sched, factors: factorsFor(L.isPoints), rosters, myTeamId: me, otherTeamId: other,
        give, get, fromSp: fromSp(),
      };
      const an = needInsights('analyzeTrade');
      res = an.analyzeTrade(Object.assign({ toSp: fromSp() + 27 }, args));
      ros = an.analyzeTrade(Object.assign({ toSp: L.finalSp }, args));
    } catch (err) {
      if (window.console) console.error(err);
      return inlineErrorHTML('Could not price this trade. ' + ((err && err.message) || ''));
    }
    const card = (name, side, you) => {
      const x = side || {};
      return '<div class="wp-ba' + (you ? ' is-you' : '') + '"><p class="wp-ba-t">' + esc(name) + '</p>' +
        '<p class="wp-ba-n"><span class="from">' + f1(x.before) + '</span><span class="mid">to</span><b>' + f1(x.after) + '</b></p>' +
        '<p class="wp-ba-d ' + (x.delta > 0.049 ? 'good' : x.delta < -0.049 ? 'bad' : '') + '">' + sgn1(x.delta) + ' FP a week</p>' +
        '<p class="wp-dim">Rest of season ' + sgn1((you ? ros.me : ros.them).delta) + ' a week</p></div>';
    };
    const d = res.drops || {};
    const notes = [];
    if (d.me) notes.push('<p>You would be over the roster limit, so <b>' + esc(d.me.name) + '</b> (your lowest projection) gets dropped.</p>');
    if (d.them) notes.push('<p>' + esc(teamName(t.team)) + ' would be over the limit and drop <b>' + esc(d.them.name) + '</b>.</p>');
    return '<div class="wp-ba-grid">' + card(teamName(me), res.me, true) + card(teamName(t.team), res.them, false) + '</div>' +
      '<div class="wp-drops">' + (notes.join('') || '<p class="wp-dim">Nobody has to be dropped.</p>') + '</div>';
  }

  function analyzerHTML() {
    const L = S.base.league, me = String(S.base.myTeamId), rosters = S.lg.rosters || {};
    const t = tradeState();
    const teams = Object.keys(rosters).filter((id) => id !== me).map((id) => ({ id, name: teamName(id), rec: L.teams && L.teams[id] && L.teams[id].record }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const opts = '<option value="">Choose a team</option>' + teams.map((x) =>
      '<option value="' + esc(x.id) + '"' + (x.id === t.team ? ' selected' : '') + '>' + esc(x.name) + (x.rec ? ' (' + esc(recText(x.rec)) + ')' : '') + '</option>').join('');
    const picks = t.team
      ? '<div class="wp-picks">' + pickColHTML('give', 'You give', rosters[me] || [], t.give) + pickColHTML('get', 'You get', rosters[t.team] || [], t.get) + '</div>'
      : '<div class="wp-empty"><p>Choose a team to start, or load one of the trade ideas.</p></div>';
    return secHead('h-an', 'Trade analyzer', 'Points a week from each team’s best lineup over the next 4 weeks, with schedule and rest days included. The rest of the season, playoffs included, is shown underneath.') +
      '<div class="wp-tradebar"><label class="wp-field"><span>Trade with</span><select class="wp-select" data-act="trade-team" data-focus="trade-team">' + opts + '</select></label>' +
      (t.team ? '<button type="button" class="wp-btn wp-btn--quiet" data-act="trade-clear" data-focus="trade-clear">Clear picks</button>' : '') + '</div>' +
      picks +
      (t.team ? '<div class="wp-trade-result" id="wp-trade-result" tabindex="-1" aria-live="polite">' + tradeResultHTML() + '</div>' : '');
  }

  function ideasHTML() {
    const head = secHead('h-ideas', 'Trade ideas', 'One-for-one, two-for-one and one-for-two swaps that raise the weekly points of both teams over the next 4 weeks. Pick one to load it into the analyzer.');
    const m = S.memo.ideas;
    if (!m) { scheduleIdeas(); return head + loadingHTML('Looking for trades that help both teams…', true); }
    if (m.error) return head + inlineErrorHTML('Could not search for trades. ' + (m.error.message || ''));
    if (!m.list.length) return head + '<div class="wp-empty"><p>No swap makes both teams better right now. Check again after more games.</p></div>';
    const names = (a) => a.map((p) => esc(p.name)).join(', ');
    return head + '<ol class="wp-ideas">' + m.list.map((x, i) =>
      '<li><button type="button" class="wp-idea" data-act="idea" data-i="' + i + '" data-focus="idea-' + i + '">' +
      '<span class="wp-idea-t">' + esc(teamName(x.teamId)) + '</span>' +
      '<span class="wp-idea-l"><i>You give</i> ' + names(x.give || []) + '</span>' +
      '<span class="wp-idea-l"><i>You get</i> ' + names(x.get || []) + '</span>' +
      '<span class="wp-idea-g">You <b class="good">' + sgn1(x.myGain) + '</b> · them <b class="good">' + sgn1(x.theirGain) + '</b> FP a week</span>' +
      '</button></li>').join('') + '</ol>';
  }

  // The search can take a second or two, so the page paints first and the list fills in after.
  let ideasPending = false;
  function scheduleIdeas() {
    if (ideasPending) return;
    ideasPending = true;
    const ver = S.lgVer;
    setTimeout(() => {
      ideasPending = false;
      if (ver !== S.lgVer || !S.lg) return;
      const L = S.base.league;
      try {
        S.memo.ideas = { list: needInsights('tradeIdeas').tradeIdeas({ league: L, sched: S.base.sched, factors: factorsFor(L.isPoints), rosters: S.lg.rosters || {}, myTeamId: S.base.myTeamId, fromSp: fromSp() }) || [] };
      } catch (err) {
        if (window.console) console.error(err);
        S.memo.ideas = { error: err, list: [] };
      }
      if (S.view === 'trades') renderIdeas();
    }, 40);
  }

  function tradesHTML() {
    return '<div class="wp-view"><div class="wp-pair">' +
      '<section class="wp-sec" id="wp-analyzer" aria-labelledby="h-an">' + analyzerHTML() + '</section>' +
      '<section class="wp-sec" id="wp-ideas" aria-labelledby="h-ideas">' + ideasHTML() + '</section>' +
      '</div></div>';
  }

  function renderAnalyzer() {
    const el = document.getElementById('wp-analyzer');
    if (!el || !S.lg) return;
    const f = captureFocus();
    el.innerHTML = analyzerHTML();
    restoreFocus(f);
  }
  function renderIdeas() {
    const el = document.getElementById('wp-ideas');
    if (el && S.lg) el.innerHTML = ideasHTML();
  }
  function renderTradeResult() {
    const el = document.getElementById('wp-trade-result');
    if (!el) return;
    el.innerHTML = tradeResultHTML();
    ['give', 'get'].forEach((side) => {
      const c = app.querySelector('[data-count="' + side + '"]');
      if (c) c.textContent = countText(S.trade[side].size);
    });
  }

  function loadIdea(i) {
    const m = S.memo.ideas;
    const x = m && m.list && m.list[i];
    if (!x) return;
    S.trade = { team: String(x.teamId), give: new Set((x.give || []).map((p) => String(p.id))), get: new Set((x.get || []).map((p) => String(p.id))) };
    renderAnalyzer();
    const el = document.getElementById('wp-analyzer');
    if (el) { try { el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }); } catch (e) { /* older browsers */ } }
    const res = document.getElementById('wp-trade-result');
    if (res) res.focus({ preventScroll: true });
  }

  /* ---- League */

  function leagueHTML() {
    const L = S.base.league, me = String(S.base.myTeamId);
    const rows = memo('power', () => needInsights('powerRankings').powerRankings({
      league: L, sched: S.base.sched, factors: factorsFor(L.isPoints), rosters: (S.lg && S.lg.rosters) || {}, matchups: (S.lg && S.lg.matchups) || [], fromSp: fromSp(),
    })) || [];
    const top = rows.reduce((m, r) => Math.max(m, isNum(r.strength) ? r.strength : 0), 0);
    const body = rows.map((r) => {
      const mine = String(r.teamId) === me;
      const w = top > 0 && isNum(r.strength) ? Math.max(4, Math.round((r.strength / top) * 100)) : 0;
      return '<tr' + (mine ? ' class="is-me"' : '') + '>' +
        '<th scope="row" class="wp-stick"><span class="wp-tm"><span class="wp-rk">' + r.rank + '</span><span class="wp-tm-n">' + esc(r.name) + '</span>' + (mine ? '<span class="wp-tag wp-tag--you">You</span>' : '') +
        '</span></th>' +
        '<td>' + esc(recText(r.record)) + '</td>' +
        '<td>' + f1(r.pf) + '</td>' +
        '<td class="wp-sc"><span>' + f1(r.strength) + '</span><i class="wp-sbar" style="width:' + w + '%"></i></td>' +
        '<td>' + f1(r.sos) + '</td></tr>';
    }).join('');
    return '<div class="wp-view"><section class="wp-sec" aria-labelledby="h-power">' +
      secHead('h-power', 'Power rankings', 'Strength is the points a week each team’s best lineup should score over the next 28 days, from today’s rosters. Schedule is the average strength of the opponents still to come this regular season, so a higher number is a tougher road.') +
      (rows.length
        ? '<div class="wp-tscroll wp-tscroll--power" tabindex="0" role="region" aria-label="Power rankings"><table class="wp-dt wp-dt--power"><caption class="wp-sr">Power rankings</caption>' +
          '<thead><tr><th scope="col" class="wp-stick">Team</th><th scope="col">Record</th><th scope="col">Points for</th><th scope="col">Strength a week</th><th scope="col">Schedule</th></tr></thead>' +
          '<tbody>' + body + '</tbody></table></div>'
        : '<div class="wp-empty"><p>No teams to rank yet. Refresh to load every roster.</p></div>') +
      '</section></div>';
  }

  function leagueBodyHTML() {
    if (!S.lg) {
      if (S.lgError) return errorHTML(S.lgError, 'Could not load league data', 'retry-league');
      return loadingHTML('Loading every roster in the league…');
    }
    try {
      switch (S.view) {
        case 'playoffs': return playoffsHTML();
        case 'trends': return trendsHTML();
        case 'trades': return tradesHTML();
        default: return leagueHTML();
      }
    } catch (err) {
      if (window.console) console.error(err);
      const names = { playoffs: 'the playoff planner', trends: 'trends', trades: 'trades', league: 'the power rankings' };
      return softErrorHTML('Could not build ' + (names[S.view] || 'this view'), err);
    }
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
    if (S.view !== 'week') return leagueBodyHTML();
    if (S.error && !S.vm) return errorHTML(S.error);
    if (!S.vm) return loadingHTML('Loading ' + ((S.base && S.base.weeks[S.weekIdx] && S.base.weeks[S.weekIdx].label) || 'week') + '…');
    const vm = S.vm;
    return heroHTML(vm) +
      planHTML(vm) +
      '<div class="wp-pair">' + edgeHTML(vm) + teamsHTML(vm) + '</div>' +
      nightsHTML(vm) +
      '<section class="wp-sec wp-roster" id="wp-roster" aria-labelledby="h-roster">' + rosterHTML(vm) + '</section>' +
      '<section class="wp-sec wp-boardsec" id="wp-board" aria-labelledby="h-board">' + boardHTML(vm) + '</section>' +
      footHTML();
  }

  function errorHTML(err, title, act) {
    const msg = (err && err.message) || String(err || 'Unknown error');
    return '<div class="wp-panel wp-errorpanel" role="alert"><h2>' + esc(title || 'Could not load this week') + '</h2>' +
      '<p>' + esc(msg) + '</p><p class="wp-dim">Check your connection and that the server is still running, then try again.</p>' +
      '<div class="wp-form-actions"><button type="button" class="wp-btn wp-btn--primary" data-act="' + (act || 'retry') + '">Try again</button></div></div>';
  }

  function renderBody() {
    const el = document.getElementById('wp-body');
    if (!el) return;
    const f = captureFocus();
    const y = window.scrollY;
    const onWeek = S.view === 'week';
    if (onWeek && S.vm && S.gridWeek === S.vm.week.id) {
      const sc = el.querySelector('.wp-scroll');
      if (sc) S.gridLeft = sc.scrollLeft;
    }
    el.classList.toggle('is-busy', !!(onWeek && S.loading && S.vm));
    el.classList.toggle('is-enter', !!S.enter);
    S.enter = false;
    el.innerHTML = bodyHTML();
    watchGrid();
    alignGrid();
    restoreFocus(f);
    if ((onWeek ? S.vm : S.lg) && y) window.scrollTo(0, y);
    if (S.base) {
      if (onWeek && S.vm) {
        const w = S.base.weeks[S.weekIdx];
        document.title = (w ? w.label + ' · ' : '') + 'Week planner';
      } else if (!onWeek) {
        const v = VIEWS.filter((x) => x[0] === S.view)[0];
        document.title = (v ? v[1] + ' · ' : '') + 'Week planner';
      }
    }
  }

  function renderViews() {
    const el = document.getElementById('wp-views');
    if (!el) return;
    const f = captureFocus();
    el.innerHTML = viewsHTML();
    restoreFocus(f);
  }

  // The League, Trends, Trades and Playoffs views share one cached loadLeague() result.
  function ensureLeague(opts) {
    opts = opts || {};
    if (S.phase !== 'ready') return;
    if (S.lg && !opts.force) return;
    if (S.lgLoading && !opts.force) return;
    if (!S.client || typeof S.client.loadLeague !== 'function') {
      S.lgError = new Error('The data layer cannot load league-wide data yet. Update espn.js, then reload this page.');
      return;
    }
    const my = ++S.lgToken;
    S.lgLoading = true;
    S.lgError = null;
    if (!opts.keep) { S.lg = null; resetDerived(); }
    const done = () => { if (S.view !== 'week') { renderTop(); renderBody(); } };
    let p;
    try { p = Promise.resolve(S.client.loadLeague(S.base)); } catch (err) { p = Promise.reject(err); }
    p.then((data) => {
      if (my !== S.lgToken) return;
      S.lg = data || { rosters: {}, matchups: [], freeAgents: [] };
      S.lgLoading = false;
      resetDerived();
      done();
    }, (err) => {
      if (my !== S.lgToken) return;
      S.lgLoading = false;
      if (handleLoadError(err)) return;
      if (window.console) console.error(err);
      if (!S.lg) S.lgError = err;
      done();
    });
  }

  function setView(v) {
    if (VIEWS.every((x) => x[0] !== v) || v === S.view) return;
    S.view = v;
    store.set('wp:view', v);
    if (hashView() !== v) { try { window.location.hash = v; } catch (e) { /* the view still changes */ } }
    S.enter = true;
    if (v !== 'week') ensureLeague();
    renderTop();
    renderViews();
    renderBody();
  }

  function renderShell() {
    app.innerHTML = '<main class="wp-wrap"><h1 class="wp-sr">Week planner</h1><div id="wp-top"></div><div id="wp-views"></div><div id="wp-body"></div></main>';
    renderTop();
    renderViews();
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

  // Win chance for the loaded week, computed once per week render. A bye or a finished week has none.
  function computeWin(vm) {
    try {
      if (!vm || !vm.opp || vm.days.every((d) => d.kind === 'past')) return null;
      const wp = needInsights('winProbability').winProbability(vm, { factors: factorsFor(vm.isPoints) });
      return wp && isNum(wp.pWin) ? wp : null;
    } catch (err) {
      if (window.console) console.warn(err);
      return null;
    }
  }

  // The week plan (WPModel.planWeek). The page works without it: any failure leaves the nights on their own.
  function computePlan(ctx, vm) {
    try {
      const M = window.WPModel;
      if (!vm || typeof M.planWeek !== 'function' || !vm.days.some((d) => d.kind !== 'past')) return null;
      return M.planWeek(ctx, { vm });
    } catch (err) {
      if (window.console) console.warn(err);
      return null;
    }
  }

  async function loadWeekAt(idx, opts) {
    const silent = !!(opts && opts.silent);
    const my = ++S.token;
    S.weekIdx = idx;
    S.error = null;
    S.loading = true;
    if (!silent) { S.vm = null; S.wp = null; S.plan = null; }
    renderTop();
    if (S.view === 'week') renderBody();
    try {
      const week = S.base.weeks[idx];
      const ctx = await S.client.loadWeek(S.base, week);
      if (my !== S.token) return;
      const vm = window.WPModel.computeWeek(ctx);
      if (my !== S.token) return;
      S.vm = vm;
      S.wp = computeWin(vm);
      S.plan = computePlan(ctx, vm);
      S.syncedAt = Date.now();
      S.loading = false;
      S.enter = !silent;
    } catch (err) {
      if (my !== S.token) return;
      S.loading = false;
      if (handleLoadError(err)) return;
      if (silent && S.vm) { S.error = null; } else { S.error = err; S.vm = null; S.wp = null; S.plan = null; }
      if (window.console) console.error(err);
    }
    renderTop();
    if (S.view === 'week') renderBody();
  }

  async function boot() {
    S.phase = 'boot';
    S.lg = null; S.lgError = null; S.lgLoading = false; S.lgToken++;
    resetDerived();
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
      rememberLeague(cfg, S.base);
      S.phase = 'ready';
      S.weekIdx = pickWeekIndex(S.base);
      if (S.view !== 'week') ensureLeague();
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
    // League-wide data: reload now if it is on screen, otherwise drop it so the next visit loads fresh.
    if (S.view !== 'week') { ensureLeague({ force: true, keep: !!silent && !!S.lg }); renderBody(); }
    else { S.lg = null; S.lgError = null; S.lgLoading = false; S.lgToken++; resetDerived(); }
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
      if (act === 'theme') {
        S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length];
        store.set('wp:theme', S.theme);
        applyTheme(S.theme);
        return renderTop();
      }
      if (act === 'view') return setView(t.dataset.view);
      if (act === 'retry-league') { ensureLeague({ force: true }); renderTop(); return renderBody(); }
      if (act === 'retry-view') { resetDerived(); return renderBody(); }
      if (act === 'idea') return loadIdea(parseInt(t.dataset.i, 10));
      if (act === 'trade-clear') { S.trade.give.clear(); S.trade.get.clear(); return renderAnalyzer(); }
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
    if (!t || !t.matches) return;
    if (t.matches('select[data-act="week"]')) loadWeekAt(clamp(parseInt(t.value, 10) || 0, 0, S.base.weeks.length - 1));
    else if (t.matches('select[data-act="league"]')) switchLeague(t.value);
    else if (t.matches('select[data-act="trade-team"]')) { S.trade = { team: t.value || null, give: new Set(), get: new Set() }; renderAnalyzer(); }
    else if (t.matches('input[data-act="trade-pick"]')) {
      const set = t.dataset.side === 'give' ? S.trade.give : S.trade.get;
      if (t.checked) set.add(t.dataset.id); else set.delete(t.dataset.id);
      renderTradeResult();
    }
  });

  app.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form="setup"]');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    const v = (k) => String(fd.get(k) || '').trim();
    const payload = { league: v('league') };
    if (v('espn_s2')) payload.espn_s2 = v('espn_s2');
    if (v('swid')) payload.swid = v('swid');
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
      S.setup = { add: !!(S.setup && S.setup.add), message: (err && err.message) || 'Could not save the settings.', values: { league: payload.league, season: payload.season || '', teamId: payload.teamId || '', swid: payload.swid || '' } };
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

  window.addEventListener('hashchange', () => {
    const v = hashView();
    if (v && S.phase === 'ready') setView(v);
  });

  document.addEventListener('keydown', (e) => {
    if (S.phase !== 'ready' || S.view !== 'week' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.closest && t.closest('.wp-scroll')))) return;
    e.preventDefault();
    go(e.key === 'ArrowLeft' ? -1 : 1);
  });

  window.WPApp = { state: S, reload: boot, refresh, go, esc };
  boot();
})();
