# Week Planner — build spec (shared contract for all agents)

A local web app that replicates (and improves on) League Winner's "Weekly Slate" for one ESPN
fantasy basketball league. Runs on the user's computer: `python server.py` → opens
`http://127.0.0.1:8765`. No build step, no npm deps at runtime, Python stdlib only.
Must work on Windows (work laptop) and macOS/Linux (personal).

The user's league: ESPN `fba`, season `2027` (= 2026‑27 NBA), leagueId `1257343892`,
16 teams, H2H **points**, his team id `6` ("Thanos was right"). These go in
`config.example.json` as defaults; secrets never get committed.

## What the reference product shows (reverse-engineered)

1. Week pager: "Week 2 · Oct 26 – Nov 1" (weeks Mon–Sun).
2. **Games per team** this week, grouped by count (4: ATL BOS …; 3: …; 2: PHX).
3. **Games this week · you vs opponent**: per day "7 v 7", totals "22 left vs 17 opp, +5 games",
   "22 v 23 played so far, 44 v 40 for the week". A finished night counts players who actually
   played in an active lineup slot; a future game excludes players ruled OUT. Counts are capped
   by lineup slots (10 starters here).
4. **Roster guide**: grid player × day. Past: actual fantasy points + opponent. Future: projected
   FP (grey) + opponent, injury flags (Q / OUT / DNP). Week column = total (actual + projected) and
   "x so far". Row expands: "on pace for 169.8 this week, +29.2 vs projection", form (last 4),
   per‑game cards with PTS/REB/AST.
5. **Night cards** (one per day): "3 of 13 play", "Best add: Jock Landale · ATL · 2 of 4 left ·
   21.5 FP · C · 1% rostered · Drop Sexton · not an upgrade", "If not him …", "+2 options",
   "2 of 7 adds used this week · 5 left".

We do all of that, from ESPN data only, plus: correct merged weeks (All‑Star), lineup-optimal
counting with real position eligibility, waiver-aware streaming, a streaming board, opponent view.

## ESPN API facts (verified live on the user's league, Oct 29 2026)

Base: `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/`
League path `L = seasons/2027/segments/0/leagues/1257343892`. Private league: needs cookies
`espn_s2` and `SWID` (401 without). Multiple `view=` params allowed. Optional header
`x-fantasy-filter: <json>`.

| Request | Notes |
|---|---|
| `L?view=mSettings&view=mTeam&view=mStatus` | settings, teams (with `owners` = SWIDs, `transactionCounter`), status. |
| `L?view=mMatchup` + filter `{"schedule":{"filterTeamIds":{"value":[6]}}}` | only my matchups (19 regular). Each item: `matchupPeriodId`, `home`/`away`: `{teamId, totalPoints, pointsByScoringPeriod:{"7":206.4,"8":94,...}}`. Without the filter the response is 600KB+. |
| `seasons/2027?view=proTeamSchedules_wl` | public, 413KB. `settings.proTeams[]`: `{id, abbrev, location, name, proGamesByScoringPeriod:{ "<sp>": [ {id, date(ms UTC), homeProTeamId, awayProTeamId, scoringPeriodId, startTimeTBD, statsOfficial} ] }}`. 31 teams incl. id 0 (free agents) — skip id 0. |
| `L?view=mRoster&scoringPeriodId=S&rosterForTeamId=6&rosterForTeamId=4` | rosters **as of day S** for those teams only (`teams[]` contains only teams with `roster`). Entry: `{playerId, lineupSlotId, injuryStatus, playerPoolEntry:{player:{...}}}` |
| `L?view=mMatchupScore&scoringPeriodId=S` + same team filter | 8KB. The matchup whose `home.rosterForCurrentScoringPeriod` (or `away.`) exists is the matchup period containing day S. Used to map weeks (see below). |
| `L?view=kona_player_info&scoringPeriodId=S` + players filter | free agents. `players[]`: `{id, status:'FREEAGENT'|'WAIVERS', waiverProcessDate(ms), onTeamId, player:{...}}` |
| `L?view=mTransactions2&scoringPeriodId=S` | `transactions[]`: `{teamId, type:'FREEAGENT'|'WAIVER'|'ROSTER'|'TRADE_PROPOSAL'|'FUTURE_ROSTER', status:'EXECUTED'|'PENDING'|'CANCELED'|'FAILED_…', scoringPeriodId, items:[{type:'ADD'|'DROP'|..., playerId}]}` |

Free-agent filter (x-fantasy-filter):
```json
{"players":{"filterStatus":{"value":["FREEAGENT","WAIVERS"]},
 "filterSlotIds":{"value":[0,1,2,3,4,5,6,11]},
 "sortPercOwned":{"sortPriority":1,"sortAsc":false},"limit":250,
 "filterStatsForTopScoringPeriodIds":{"value":5,"additionalValue":["002027","102027","012027","022027","002026"]}}}
```

### Player object (`player`)
`id, fullName, firstName, lastName, proTeamId, defaultPositionId (1 PG,2 SG,3 SF,4 PF,5 C),
eligibleSlots:[slotIds], injuryStatus ('ACTIVE'|'DAY_TO_DAY'|'OUT'|'INJURY_RESERVE'|'SUSPENSION'),
ownership:{percentOwned, percentChange}, stats:[StatEntry]`

StatEntry: `{id, statSourceId (0 actual,1 ESPN projection), statSplitTypeId, scoringPeriodId,
appliedTotal, appliedAverage, stats:{ "<statId>": value }}`. `appliedTotal/appliedAverage` are
**already in this league's fantasy points**. id format `<source><split><season>`:
- `002027` season-to-date actual (split 0) · `012027` last 7 · `022027` last 15 · `032027` last 30
- `102027` ESPN season projection (`appliedAverage` = projected FP/game, `stats[42]` projected GP)
- `002026` last season actual
- per-game: split 5, id `05<gameId>`, `scoringPeriodId` = the day, `stats[42]` = 1 if played.
  A roster fetched for day S includes the per-game entry for S if he played that day.

Stat ids: 0 PTS, 1 BLK, 2 STL, 3 AST, 4 OREB, 5 DREB, 6 REB, 11 TO, 13 FGM, 14 FGA, 15 FTM,
16 FTA, 17 3PM, 18 3PA, 40 MIN, 41 GS, 42 GP.

### Lineup slots
`settings.rosterSettings.lineupSlotCounts` e.g. `{"0":1,"1":1,"2":1,"3":1,"4":1,"5":1,"6":1,"7":0,"8":0,"9":0,"10":0,"11":3,"12":3,"13":1}`.
Names: 0 PG, 1 SG, 2 SF, 3 PF, 4 C, 5 G, 6 F, 7 SG/SF, 8 G/F, 9 PF/C, 10 F/C, 11 UTIL, 12 Bench, 13 IR.
Starting slots = everything except 12, 13 (here 10 starters, 3 bench, 1 IR).

### Add limit
`settings.acquisitionSettings`: `matchupAcquisitionLimit` (1; -1 = unlimited),
`matchupLimitPerScoringPeriod` (true ⇒ the limit is counted per day of the matchup, so 1 ⇒ 7 for a 7-day week).
Checked on both leagues, Nov 10 2026: it is a budget for the whole matchup, not one a day. 32 of 106
team-days had 2 or more adds (up to 4), three teams hit exactly 7 in a week and nobody went above.
Weekly used count: `team.transactionCounter.matchupAcquisitionTotals[mpId]`.
Per-day used: count my EXECUTED FREEAGENT/WAIVER transactions with an ADD item, by `scoringPeriodId`.

### Days and weeks
- Scoring period (sp) = one day. sp 1 = opening night (Tue 2026‑10‑20). `status.latestScoringPeriod`
  (also top-level `scoringPeriodId`) = today (10 on Thu Oct 29). `status.finalScoringPeriod` = 174.
- Derive `startDate` from the schedule: for every game, `etDate(game.date) − (sp − 1) days`; take the mode.
  All dates are **US Eastern** calendar dates (`Intl` with `America/New_York`).
- Calendar week k: week 1 starts on the Monday on/before startDate; offset = (weekday(startDate)+6)%7;
  `calendarWeekOf(sp) = floor((sp − 1 + offset)/7) + 1`; first sp of week k = `7(k−1) − offset + 1` clamped to ≥ 1.
- **Matchup periods are NOT always calendar weeks.** Verified by probing: calendar weeks 1–17 = matchups 1–17,
  calendar weeks 18+19 = matchup 18 (All-Star break, 2 weeks), calendar week 20 = matchup 19.
  `scheduleSettings.matchupPeriods` = `{"1":[1],…,"19":[19],"20":[20],"21":[21,22],"22":[23,24]}` maps matchup →
  ESPN's internal week ids; `matchupPeriodCount` = 19 regular-season matchups; 20–22 = playoffs.
  So the app must **probe** (see `buildWeeks`).

## Files and owners

```
server.py            agent B   Python stdlib server + ESPN proxy + config
config.example.json  agent B
start.bat, start.sh  agent B
README.md            agent B
.gitignore           agent B   (config.json, .cache/, __pycache__/, node_modules/, *.log)
web/espn.js          agent B   data layer (global WPData)
web/demo-data.js     agent B   fake ESPN raw responses (global WPDemo) for ?demo mode and UI dev
web/model.js         agent A   pure logic (global WPModel / module.exports)
tests/model.test.js  agent A   node:test, run with `node --test tests/`
web/index.html       agent C
web/styles.css       agent C
web/app.js           agent C   UI (global-free IIFE, renders into #app)
```
All browser files are classic scripts (no ES modules) loaded in this order:
`model.js, espn.js, demo-data.js, app.js`. model.js must also work in Node via `require`.
UMD pattern:
```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WPModel = api;
})(typeof self !== 'undefined' ? self : globalThis, function () { 'use strict'; /* ... */ return {...}; });
```
Do not edit files you don't own. If you need something from another module, code against this spec.

## Module contract: web/model.js (`WPModel`) — pure, no fetch, no DOM

Constants: `SLOT_NAMES`, `STARTING_EXCLUDE = [12,13]`, `OUT_STATUSES = ['OUT','INJURY_RESERVE','SUSPENSION']`, `STAT`.

Dates: `etDate(ms) → 'YYYY-MM-DD'` (America/New_York), `addDays(d, n)`, `diffDays(a, b)` (a−b in days),
`weekdayOf(d)` (0 Sun … 6 Sat), `fmtRange(d1, d2) → 'Oct 26 – Nov 1'` / `'Feb 15 – 28'`.

### `normLeague(leagueRaw, schedRaw?) → League`
```
{ id, season, name, size, scoringType, isPoints (scoringType includes 'POINTS'),
  caps: { "<slotId>": count }   // starting slots with count>0 (exclude 12,13)
  starters: Σ caps, benchCount, irCount,
  acq: { limit, perDay },
  matchupPeriods, regularCount,
  currentSp, currentMp, firstSp, finalSp,
  teams: { [id]: { id, name (t.name || location+' '+nickname, trimmed), abbrev, owners:[...], logo, record:{wins,losses,ties}, addsByMp: {...matchupAcquisitionTotals} } },
  matchups: [ { mp, home:{teamId,total,bySp}, away:{teamId,total,bySp} } ]   // from schedRaw.schedule if given else leagueRaw.schedule || []
}
```
`detectMyTeam(league, swid) → teamId|null` (compare owners case-insensitively, normalise braces `{...}`).

### `buildProSchedule(proRaw) → Sched`
```
{ startDate, teams: {[proId]: {id, abbrev, name}}, games: {[gameId]: {id, sp, date, home, away, tbd}},
  gamesBySp: {[sp]: [game]}, byTeam: {[proId]: {[sp]: gameId}} }
```
Helpers: `teamGame(sched, proId, sp) → game|null`, `spDate(sched, sp)`, `dateSp(sched, 'YYYY-MM-DD')`,
`calendarWeekOf(sched, sp)`, `calendarWeekSps(sched, k, finalSp) → [sp…]`.

### `buildWeeks({ sched, league, probe }) → Week[]`
`probe` = `{ [calendarWeek]: matchupPeriodId }` from the data layer (may be `{}` → fallback 1:1).
1. For each regular matchup m (1..regularCount): calendar weeks `C(m)` = probe keys whose value is m.
   Map its internal ids `matchupPeriods[m]` to those calendar weeks (if one id: all of C(m); if counts equal: pairwise).
2. Walk all internal ids ascending; an unmapped id u gets `[lastC + (u − lastU)]` from the last mapped one
   (or `[u]` if none mapped yet).
3. Week for every matchup key m: calendar weeks = union over its ids; `sps` = all days of those calendar
   weeks within `[1, finalSp]`.
```
Week = { id: m, sps, first, last, calWeeks, playoff: m > regularCount, long: sps.length > 7,
         label: playoff ? 'Playoffs · round N' : 'Week m', range: fmtRange(...) }
```
Test case: probe `{1:1,…,17:17,18:18,19:18,20:19}` with the matchupPeriods above ⇒ matchup 18 = calendar 18–19
(14 days), 19 = calendar 20, 20 = calendar 21, 21 = calendar 22–23, 22 = calendar 24–25 (ends sp 174).

### `normPlayer(entryOrPlayerPoolEntry) → Player`
Accepts a roster entry (`{lineupSlotId, injuryStatus, playerPoolEntry:{player}}`) or a kona entry
(`{id, status, waiverProcessDate, player}`):
```
{ id, name, first, last, proTeamId, posId, pos ('SF/PF' from eligibleSlots ∩ 0..4 in PG,SG,SF,PF,C order),
  eligible, injury, slot (lineupSlotId or null), status ('ONTEAM'|'FREEAGENT'|'WAIVERS'),
  waiverDate (ms|null), own: {pct, chg}, stats }
```
`gameStat(player, sp)` → the split-5 actual entry for that day or null. `boxOf(statEntry)` →
`{pts, reb, ast, stl, blk, to, min, fgm, fga, tpm}`.

### `projectPlayer(player, season, isPoints=true) → Proj`
```
cur = '00'+season, proj = '10'+season, prev = '00'+(season-1), l15 = '02'+season, l30 = '03'+season (else l15)
avg(e) = e.appliedAverage || (e.stats[42] ? e.appliedTotal / e.stats[42] : null)
n = cur.stats[42] || 0; curAvg = n ? avg(cur) : null; prior = avg(proj) ?? avg(prev)
n15 = min(gp(l15), n); n30 = min(gp(l30), n)
fp = prior == null ? (curAvg ?? avg(l15) ?? 0) : curAvg == null ? prior
   : (n*curAvg + n30*avg(l30) + n15*avg(l15) + 10*prior) / (n + n30 + n15 + 10)
minutes (n >= 5, both splits carry stats[40]): fp *= 1 + clamp(0.5 * n15/(n15+3) * (mpg(l15)/mpg(cur) - 1), ±0.5)
→ { fp, curAvg, n, prior, espnProj: avg(proj), l15: avg(l15), l15n, prevAvg, mpg, mpgL15, minTrend }
```
Weights fitted on 2025-26 and checked on 2024-25 (tools/backtest.js); see Phase 3 at the end.
Non-points leagues: `fp = 1` for everyone (so "value" = games that reach the lineup).

### `bestLineup(cands, caps) → { chosen: cand[], total, slotOf: Map(candKey → slotId) }`
`cands = [{ key, w, slots: [slotIds] }]`. Expand caps into slot instances; sort cands by `w` desc; insert each
with an augmenting-path DFS (Kuhn). Greedy-by-weight on a transversal matroid ⇒ max-weight lineup and max
cardinality. Players whose slot list has no starting slot are never chosen.

### `computeWeek(ctx) → WeekVM`
```
ctx = { league, sched, week, now (ms), myTeamId,
        rosters: { [teamId]: { current: Player[], bySp: { [sp]: Player[] } } },  // bySp only for week days ≤ currentSp
        freeAgents: Player[], transactions: rawTx[] }
```
Opponent = other side of `league.matchups` item with `mp === week.id` containing myTeamId (null if bye).

Day kind: `sp < currentSp` past, `=== currentSp` today, `>` future. A game is *started* when `game.date <= now`.

Per team, per day:
- **past**: roster = `bySp[sp]` (fallback `current`). For each player with a team game that day:
  stat = `gameStat(p, sp)`; played = stat && stat.stats[42] > 0.
  Active slot (not 12/13) & played ⇒ counted (`played++`, `playedPts += appliedTotal`).
  Cell `{t:'played', fp, counted, why: null|'bench'|'ir', opp, home, live:false, box}` or `{t:'dnp', opp, home, why: OUT? 'out':'dnp'}`.
- **today**: started games behave like past (`live: true`) using `bySp[sp] || current`; an active-slot player whose
  game started counts even if no stat yet (unless OUT). Each counted player consumes one unit of his slot's cap.
  Unstarted games: optimise like future with the reduced caps.
- **future**: cands = current roster players with slot ≠ 13, not OUT, team plays that day;
  `bestLineup(cands, league.caps)` with `w = proj.fp`. Chosen ⇒ cell `{t:'proj', fp, opp, home, start:true, out:false, dtd, tip}`;
  not chosen ⇒ same with `start:false` (squeezed). OUT players with a game ⇒ `{t:'proj', …, out:true, start:false}`.
- `opp` = opponent pro team abbrev, `home` = boolean.
- Players who were on the roster on some day this week but are not in `current` appear as rows with `gone:true`.
- Current-roster players who were not on this roster on a past day: if their team played, cell
  `{t:'played', fp (from gameStat on their current entry if present else null), counted:false, why:'away'}`.

```
WeekVM = {
  week, now, isPoints,
  days: [ { sp, date, dow:'Mon', dom:26, kind, nGames, firstTip, light: nGames<=5, heavy: nGames>=11 } ],
  gamesPerTeam: [ { count, teams: [{id, abbrev}] } ]   // count desc, all 30 teams
  me: TeamWeek, opp: TeamWeek|null,
  adds: { used, weekLimit|null, perDay, limit, todayUsed, pending: [{ add:{id,name}, drop:{id,name}|null }] },
  recs: { byDay: { [sp]: Rec[] (top 3) }, board: BoardRow[] (top 25), note|null }
}
TeamWeek = { teamId, name, abbrev,
  days: { [sp]: { played, playedPts, remaining, remProj, withGame, open } },  // open = starters − played − remaining (today/future), null for past
  played, remaining, total (= played+remaining),
  actual (Σ league.matchups bySp over the week if present, else Σ playedPts), remProj, projFinal,
  rows: [ { player, proj, gone, cells: {[sp]: Cell}, soFar, rest, total, games } ]   // sorted: active slots first by slot id, then bench, IR, gone
}
Rec = { sp, fa: Player, faProj, drop: Player, dropProj, gain, gamesReach, gamesLost, upgrade: faProj.fp >= dropProj.fp, waiver: fa.status==='WAIVERS' }
BoardRow = { fa, faProj, gamesLeft, days: {[sp]: 'start'|'squeezed'}, bestSp, drop, gain, upgrade }
```
Recommendations (my team only, only for days `kind !== 'past'`):
- `V(R, day)` = `bestLineup(...).total` for roster R on that day (today: unstarted games only, caps reduced by players already counted).
- Drop candidates = the 4 lowest `proj.fp` players on the current roster with slot ≠ 13.
- FA pool = free agents not OUT with ≥1 unstarted game in remaining days; take the top 80 by `fp × gamesLeft`.
- A waiver player is available from `dateSp(etDate(waiverDate))` on. Adds are only limited by the week's budget
  (`adds.left = weekLimit − used − pending claims`); see Phase 3.
- For each FA f and drop r: `delta[day] = V(R − r + f, day) − V(R, day)` for remaining days; gain from day d = suffix sum from d.
  Candidate for day d only if f has an unstarted game on d and is available on d. Keep the best r per (f, d).
- `byDay[sp]` = top 3 by gain (only gain > 0.5). `board` = per FA, its best (d, r), sorted by gain, top 25.
  `gamesReach` = games of f from d on that make the optimal lineup; `gamesLost` = r's lineup games lost.

## Data layer contract: web/espn.js (`WPData`)

```
const client = WPData.create({ mode: 'local'|'direct'|'demo', leagueId, season, teamId?, swid? })
client.get(rel, { views=[], params={}, filter=null, ttl=30 }) → Promise<json>
   query: each view → `view=<v>`; params values that are arrays → repeated keys.
   local : fetch(`/espn/${rel}?${qs}`, headers {'x-fantasy-filter': JSON (if filter), 'x-cache-ttl': ttl})
   direct: fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/${rel}?${qs}`, {credentials:'include', headers: filter only})
   demo  : WPDemo.respond(rel, { views, params, filter })  (returns a Promise of raw JSON)
   non-2xx → throw Error(msg) with .status
client.loadBase() → { league, sched, weeks, myTeamId }
   1 leagueRaw  = get(L, views mSettings,mTeam,mStatus; ttl 300)
   2 myTeamId   = opts.teamId || WPModel.detectMyTeam(normLeague(leagueRaw), opts.swid)  (throw a clear error if null)
   3 schedRaw   = get(L, view mMatchup, filter {schedule:{filterTeamIds:{value:[myTeamId]}}}, ttl 60)
   4 proRaw     = get(`seasons/${season}`, view proTeamSchedules_wl, ttl 43200)
   5 league = normLeague(leagueRaw, schedRaw); sched = buildProSchedule(proRaw)
   6 probe: for every calendar week k up to calendarWeekOf(finalSp): sp = first sp of k;
       get(L, view mMatchupScore, params {scoringPeriodId: sp}, same team filter, ttl 86400);
       the schedule item having home/away.rosterForCurrentScoringPeriod → probe[k] = its matchupPeriodId.
       Max 6 requests in flight. Cache the probe in localStorage `wp:probe:<leagueId>:<season>` for 7 days (try/catch).
   7 weeks = buildWeeks({sched, league, probe})
client.loadWeek(base, week) → ctx for computeWeek
   cur = league.currentSp; teamIds = [me, opp?]; L-roster request for each week day sp ≤ cur:
     get(L, view mRoster, params {scoringPeriodId: sp, rosterForTeamId: teamIds}, ttl sp<cur ? 3600 : 60)
   current roster = same request at sp = cur (reuse). If week.last >= cur: free agents (kona_player_info, FA filter,
   params {scoringPeriodId: cur}, ttl 300) and transactions (mTransactions2, {scoringPeriodId: cur}, ttl 60).
   Normalise with WPModel.normPlayer. Return { league, sched, week, now: Date.now() (demo: WPDemo.now), myTeamId,
   rosters, freeAgents, transactions }.
```

## Server contract: server.py (stdlib only, Python ≥ 3.8)

- `python server.py [--port 8765] [--no-browser] [--check]`. Binds **127.0.0.1** only. ThreadingHTTPServer.
  Opens the browser on start unless `--no-browser`.
- `GET /` and static files from `web/` (safe path join, correct content types, `Cache-Control: no-store`).
- `GET /config` → `{configured, leagueId, season, teamId, swid, hasS2}` (never returns espn_s2).
- `POST /config` JSON `{league (URL or id), season?, teamId?, espn_s2, swid}` → validate, normalise SWID to `{UPPER-GUID}`,
  extract leagueId from a URL (`leagueId=` query), write `config.json`, return `/config`. Reject if the `Origin`
  header is present and not this server's origin.
- `GET /espn/<rest>?<query>` → `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/<rest>?<query>` with
  `Cookie: espn_s2=<raw value as copied>; SWID=<swid>`, forwarding `x-fantasy-filter`, `Accept: application/json`,
  a browser User-Agent, gzip handled. Only that host. Cache by (rest, query, filter) for `x-cache-ttl` seconds
  (default 20, max 7 days) in memory; ttl ≥ 3600 also on disk in `.cache/`. ESPN 401/403 → respond 401
  `{"error":"espn_auth","message":"ESPN rejected the saved cookies (espn_s2 / SWID). Copy fresh ones."}`.
  Network errors → 502 JSON with the message. Respect system proxy settings (urllib default).
- `--check`: load config, fetch league settings, print league + team names, exit code 0/1.
- config.json: `{"leagueId": 1257343892, "season": 2027, "teamId": null, "espn_s2": "", "swid": ""}`.
  Season default when missing: month ≥ 8 ? year+1 : year.

## UI contract: web/app.js + index.html + styles.css

Boot: mode = `window.WP_DIRECT ? 'direct' : (?demo in URL ? 'demo' : 'local')`.
local → `GET /config`; not configured (or 401 from ESPN) → setup screen (form → `POST /config` → reload).
demo → `WPDemo.config`; direct → `window.WP_DIRECT` (`{leagueId, season, teamId}`).
Then `client.loadBase()`, pick `league.currentMp` (or the first future week after the season ends), `client.loadWeek`,
`WPModel.computeWeek(ctx)`, render. Week pager re-runs loadWeek+computeWeek. Refresh button; auto-refresh every
5 min while the tab is visible and the week contains today. Render only inside `#app`; everything app.js needs
comes from `#app` + styles.css (in direct mode it's injected into another page).

Sections (desktop ≥ 1100px two columns where noted, single column on mobile, no horizontal page scroll; the roster
grid may scroll horizontally inside its own container):
1. **Header / scoreboard (hero)**: "Thanos was right 541.4 – 646.6 Lebrontocracy", projected final under it,
   week pager (‹ select ›) with "Week 2 · Oct 26 – Nov 1" (long weeks get a note "2-week matchup (All-Star break)"),
   sync time + refresh.
2. **Games edge** (left) — totals "44 v 40 games", "22 left v 17", per-day rows of **slot pips** for me vs opp.
   **Games per team** (right) — groups by count.
3. **Nights** — one card per day: dow + date, NBA game count (light/heavy marker), my slot pips (filled = counted/
   projected starters, open slots outlined in the opportunity colour), "3 of 13 play · 7 open", best add (+ up to 2
   alternatives in a disclosure), today's add-limit note; past days show "Played 6 · 206.4 pts".
4. **Roster grid** — tabs "My team" / opponent name. Columns: player (headshot, name, pos, injury tag), one column per
   day (today highlighted), week. Cell variants per `Cell`. Click row → detail (season avg, last 15, ESPN proj,
   our proj, % rostered, per-game box lines this week).
5. **Streaming board** — top free agents: name/team/pos, % rostered (Δ), proj FP/g, games left as day pips
   (start vs squeezed), best drop, gain. Position filter.
6. Adds line: "2 of 7 adds used this week · 5 left · any day" + pending claims.

Headshot: `https://a.espncdn.com/i/headshots/nba/players/full/<id>.png` (lazy; hide on error, show initials).

### Visual direction
- Palette (CSS custom properties on `:root`, dark mode via `prefers-color-scheme` + `[data-theme]`):
  light: bg `#EEF1F5`, surface `#FFFFFF`, ink `#14203A`, ink-2 `#4B5568`, muted `#8A93A3`, line `#D9DEE6`,
  you `#1F4ED8` / you-soft `#DCE5FB`, opp `#A29A90` / opp-soft `#ECE8E3`, go (opportunity: open slots, adds) `#F06A22` /
  go-soft `#FDE6D8`, good `#1E8A5A`, bad `#C2372B`.
  dark: bg `#0F1626`, surface `#172036`, ink `#E7ECF5`, ink-2 `#AEB8CA`, muted `#77839A`, line `#26314A`,
  you `#6F95FF` / `#1C2B55`, opp `#8F887F` / `#2A2724`, go `#FF8A4C` / `#3A2418`, good `#4CC38A`, bad `#FF6B5E`.
- Type: "Big Shoulders Display" (700/800) for the hero score, week title and big counts; "IBM Plex Sans" (400/500/600)
  for everything else; `font-variant-numeric: tabular-nums` on all numbers. Google Fonts link, system fallbacks.
- Signature element: **slot pips** (one pip per starting slot). Use them consistently in games edge, night cards and
  the board. Keep everything else quiet: flat surfaces, 1px lines, modest radius (6px cards, 999px pips).
- Copy: sentence case, plain verbs, no tracked ALL-CAPS eyebrow labels, no "→" on buttons, numbers formatted to 1 decimal.
  Errors say what happened and what to do. Empty states invite an action.
- Accessibility: visible focus, `prefers-reduced-motion`, sufficient contrast, buttons are `<button>`.

---

# Phase 2 — league tools (contract, Oct 29 2026)

Seven features on top of the week planner, from ESPN data and our own measurements only (never copy
League Winner's data, files or wording). Same rules as above: stdlib Python, no build step, classic
scripts with the UMD wrapper (always also set the browser global), sentence-case copy, numbers to
1 decimal, slot pips as the signature element, works at 375px.

## Files and owners

```
web/model.js           lead     adds WPModel.gameMult (done, see below)
web/insights.js        agent A  pure logic, global WPInsights / module.exports. No fetch, no DOM.
tests/insights.test.js agent A  node:test
web/espn.js            agent B  new loader client.loadLeague + opts.fetch / opts.cookie
web/demo-data.js       agent B  answers the new requests
tools/digest.js        agent B  Node CLI printing the daily digest
web/app.js             agent C  views + wiring
web/styles.css         agent C
web/index.html         agent C  add <script src="insights.js"> after model.js
```

### Already in model.js (lead)

`WPModel.gameMult(sched, factors, proTeamId, sp) → { mult, b2b, play }`. `mult` = expected-points
multiplier for that team's game on day `sp` (venue × opponent × back-to-back output × `play`), 1 when
`factors` is null or the team has no game. `play` = chance of playing (factors.b2bPlay on the second
night of a back-to-back, else 1). Expected points for a game = `projectPlayer(p).fp × mult`.
Points leagues only: callers pass `factors = league.isPoints ? factors : null`.

## web/insights.js (`WPInsights`) — agent A

Common inputs: `league` (normLeague), `sched` (buildProSchedule), `weeks` (buildWeeks), `factors`
(WPFactors or null), `season` = league.season, Players from `normPlayer`. All functions are pure and
deterministic (seeded PRNG: mulberry32). Keep every function under ~2 s in Node for a 16-team league.

1. `winProbability(vm, { factors, sims = 5000, seed = 1, cv = 0.35, dtdPlay = 0.75 })`
   → `{ pWin, pTie, me: { mean, sd }, opp: { mean, sd } | null }`.
   Score so far = `tw.actual`. For each row cell with `t === 'proj' && start && !out` (both teams):
   play chance `q = (cell.b2b && factors ? factors.b2bPlay : 1) × (cell.dtd ? dtdPlay : 1)`;
   points if he plays `x = cell.fp / (cell.b2b && factors ? factors.b2bPlay : 1)`;
   each sim: with prob q add `max(0, x × (1 + cv × N(0,1)))`. `pWin` = share of sims me > opp,
   ties count half and are reported in `pTie`. `vm.opp` null (bye) ⇒ `pWin` null, `opp` null.
2. `winDelta(wp, gain)` → change in pWin if my mean rises by `gain` (normal approximation:
   `Φ((m+gain−o)/s) − Φ((m−o)/s)`, `s = √(sdMe² + sdOpp²)`, guard s = 0); null when `wp.opp` is null.
3. `playoffPlanner({ league, sched, weeks, factors, roster, freeAgents })`
   → `{ weeks: [{ id, label, range }], teams: [{ proId, abbrev, games: {[weekId]: n}, total, b2b }],
        mine: [{ player, proj, games: {[weekId]: n}, total, expFp }], fas: [same shape, top 25 by expFp] }`.
   Playoff weeks = `weeks.filter(w => w.playoff)`. `teams` sorted by total desc then abbrev. `expFp` =
   Σ expected points over all playoff days. `b2b` = second nights of back-to-backs in those weeks.
   `mine` excludes nobody (IR players included, sorted by expFp desc); `fas` skip OUT players.
4. `trends(players, season)` → rows `{ player, avg, n, l7, l15, n15, proj, mpg, mpgL15, startRate,
   startRateL15, delta, tag, role }`. Stat entries (FP are `appliedAverage`): season `'00'+season`,
   last 7 `'01'+season`, last 15 `'02'+season`, ESPN projection `'10'+season`. mpg = stats[40]/stats[42],
   start rate = stats[41]/stats[42] (null when missing). `base = proj ?? avg`; `delta = l15 − base`.
   `tag` (needs n15 ≥ 3): 'rising' if l15 ≥ 1.15 × base and l15 − base ≥ 3; 'falling' if
   l15 ≤ 0.85 × base and base − l15 ≥ 3; else null. `role`: 'new starter' (startRate < 0.5 and
   startRateL15 ≥ 0.6), 'lost start' (startRate ≥ 0.6 and startRateL15 < 0.4), 'more minutes'
   (mpgL15 − mpg ≥ 4), 'fewer minutes' (≤ −4), checked in that order, else null.
5. `buyLowSellHigh(rows, myTeamId)` (rows from trends over all rostered players; `row.player.onTeamId`
   is set by the data layer) → `{ buyLow: rows on other teams with tag 'falling' and base ≥ 25, sorted
   by delta asc (top 15), sellHigh: my rows with tag 'rising', sorted by delta desc }`.
6. `rosValue({ league, sched, factors, roster, fromSp, toSp })` → `{ total, perWeek, days }`: Σ over
   days of `bestLineup` total with `w = expected points` (IR slot 13 and OUT players excluded;
   `league.caps`). `perWeek = days ? total / days × 7 : 0`.
7. `analyzeTrade({ league, sched, factors, rosters, myTeamId, otherTeamId, give: [ids], get: [ids],
   fromSp, toSp })` → `{ me: { before, after, delta }, them: { before, after, delta }, drops: { me: Player|null,
   them: Player|null } }` using rosValue perWeek. A side that ends above `league.starters +
   league.benchCount` non-IR players drops its lowest-projected non-IR player (report it).
8. `tradeIdeas({ league, sched, factors, rosters, myTeamId, fromSp, horizonDays = 28, limit = 20 })`
   → `[{ teamId, give: [Player], get: [Player], myGain, theirGain }]` (gains = perWeek deltas),
   1-for-1, 2-for-1 and 1-for-2, both gains > 0, sorted by min(myGain, theirGain) desc. Prune
   candidates (e.g. top 10 by projection on each side; for 2-for-1 the single player must out-project
   each of the two) so a 16-team league runs under 2 s.
9. `powerRankings({ league, sched, factors, rosters, matchups, fromSp })` → rows `{ rank, teamId, name,
   abbrev, record: { wins, losses, ties }, pf, strength, sos }` sorted by strength desc. `strength` =
   rosValue perWeek over the next 28 days; `record` from league.teams; `pf` = Σ of the team's totals in
   matchups with mp < league.currentMp; `sos` = mean strength of its remaining regular-season
   opponents (currentMp ≤ mp ≤ league.regularCount), null if none.
10. `digest({ vm, wp, trendRows, today })` → plain text (one fact per line, no emoji): week label + range +
   score, win chance, how many of my players play today, injuries on my roster (OUT / DTD), role
   changes on my roster, best add for today (`vm.recs.byDay[today][0]`) or "No add worth it today".

## web/espn.js additions — agent B

- `WPData.create(opts)` also accepts `opts.fetch` (default `root.fetch`) and `opts.cookie` (string;
  when set in direct mode, send it as a `Cookie` header and skip `credentials` — used only by the
  Node digest).
- `client.loadLeague(base)` → `{ rosters: { [teamId]: Player[] } (current roster of every team, each
  Player with `onTeamId = teamId`), matchups: [ { mp, home, away } ] (every matchup of the season,
  same shape as league.matchups), freeAgents: Player[] }`:
  rosters: `get(L, views ['mRoster'], params { scoringPeriodId: cur }, ttl 300)` with no team filter;
  matchups: `get(L, views ['mMatchup'], ttl 300)` with no filter, normalised exactly like normLeague's
  matchups; freeAgents: the same request loadWeek makes (same cache key).
- demo-data.js answers those: rosters for all 16 teams (procedural, plausible names/positions/stats incl.
  '012027' and '022027' entries with stats 40/41/42 so some trends and role changes show up; keep teams
  6 and 4 exactly as today), and all matchups of the season with totals for finished weeks.

## tools/digest.js — agent B

`node tools/digest.js [--demo]`: reads `config.json` (leagueId, season, teamId, espn_s2, swid), loads
`web/factors.js`, `web/model.js`, `web/insights.js`, `web/espn.js` (and `web/demo-data.js` with --demo)
into one vm context, creates the client in direct mode with Node's fetch and
`cookie = 'espn_s2=<raw>; SWID=<swid>'` (demo mode with --demo), runs loadBase → current week →
loadWeek → computeWeek → WPInsights.winProbability / trends / digest and prints the text. Exit 1 with a
clear message on ESPN 401 or missing config. Never prints the cookies.

## UI — agent C

- View switcher under the top bar (buttons, `aria-pressed`): This week · Playoffs · Trends · Trades ·
  League. Remember in localStorage `wp:view`. The week pager shows only on This week.
- This week: hero shows "You win 58%" (or nothing on a bye) from `WPInsights.winProbability(vm,
  { factors })` (factors = `window.WPFactors` when `vm.isPoints`, else null); night-card best add and
  board rows show "+4% win chance" from `winDelta(wp, rec.gain)`. Compute once per week render.
- Other views call `S.client.loadLeague(S.base)` once (cache in state; Refresh reloads it) and show the
  pips loading state meanwhile; errors use the existing error pattern.
- Playoffs: playoff weeks as columns; my players (games per week, total, expected points), NBA teams
  grouped by total games, top free agents.
- Trends: my roster table (avg, last 7, last 15, projection, delta, minutes trend, tags), then
  "Buy low" and "Sell high" lists.
- Trades: analyzer — choose a team, tick players to give and get, see before/after per week for both
  sides and any forced drop; below, "Trade ideas" (click one to load it into the analyzer).
- League: power rankings table (rank, team, record, points for, strength per week, schedule strength),
  my team highlighted.


---

# Phase 3 — projections, injuries and the week plan (Nov 9 2026)

Everything here was fitted on 2025-26 and checked on 2024-25 with `tools/backtest.js`, except the return
dates, which ESPN does not keep for past seasons.

## web/model.js additions

- `projectPlayer`: recency weights and minutes trend as in the block above. Constants `PRIOR_GAMES 10`,
  `RECENT_15 1`, `RECENT_30 1`, `MIN_TREND 0.5`, `MIN_TREND_SHRINK 3`, `MIN_TREND_GP 5`.
- `availability(player, season, teamGames)` = `(n + 10*0.85) / (max(teamGames, n) + 10)`: the share of his
  team's games a player is expected to play over the coming weeks. `teamGamesBefore(sched, proId, sp)`.
- `normInjuries(raw)` → `{ [playerId]: { status, returnDate 'YYYY-MM-DD'|null, season (out for the season),
  type, note, updated } }` from ESPN's public injury report
  (`site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries`; the player id is in `athlete.links[].href`).
- `applyInjuries(players, report, sched, currentSp)` sets `p.news = { type, note, status }` and, when the
  report has a date, `p.back = { sp, date, season }` (`sp = Infinity` when out for the season; never before
  `currentSp + 1` for a player who is out today). Listed without a date ⇒ no `p.back`.
- `outOn(p, sp)` = out now and not expected back by `sp`. computeWeek uses it everywhere it used `isOut`:
  a returning player is a lineup candidate from `p.back.sp`, his cells carry `back: true` and his expected
  points are multiplied by `BACK_PLAY` (0.75). An out free agent is only suggested from that day.
- Long-term value of a move: games from the expected return on, times `availability` (points leagues).
- `recs.byDay[sp]` keeps moves with `gain > 0.5` **or** `worth` (net > 0.5), so a long-term upgrade that
  adds nothing this week is suggested. The board follows the same rule.
- A pending pickup with no drop counts towards the roster size (`joining`).
- `planWeek(ctx, { vm?, maxMoves = 7 })` → `{ moves, gain, longTerm, net, vm }`. Loop: take `vm.recs.spend`,
  add it to the context as a pending pickup on its day (synthetic PENDING transaction, the free agent's
  `waiverDate` set to noon ET that day, an `irMove` player moved to slot 13), recompute. `moves` are sorted
  by day and each carries `step` (order chosen) and `alts` (the other suggestions for that night at that
  step). `vm` is the week with the whole plan made. Each planned pickup holds one of the week's adds
  (`adds.left`), so the plan stops on its own when they run out. Several moves can share a day.
- Add budget: `adds.left = weekLimit − used − pending claims` (null when unlimited). `left === 0` ⇒ a note
  and no pickups, but activations are still looked at. There is no per-day block.
- Timing of a free-agent pickup: a night he plays, or the last day of the week (a pickup made for the
  weeks ahead can wait until the dropped player has played). A waiver claim: the day waivers clear.
- Activations: a player in an IR slot who is not out, or is expected back this week, is a candidate like
  a pickup (`rec.activate = true`), from the first day he can play. Options: the usual drops, or no drop
  when a spot is open or an Out player can swap into the IR slot he leaves (`rec.irMove`). Not on the
  board, spends no add. planWeek applies one through `ctx.activations = [{ playerId, dropId, sp }]`.

## web/insights.js additions

- `simTeam`: a `back` cell's chance of playing (`BACK_PLAY`) is already in its points, like a back-to-back.
- `makeRun.ent`: `w = fp * availability` is what a game is worth (points leagues, unless
  `args.availability === false`); `first` = first day of the run he can play (`p.back.sp - from` for an
  out player with a return date, never for an out player without one or a healthy player parked on IR).
- `digest({ …, plan? })`: with a plan, today's line is the plan's move ("In your plan today: …") or what
  is left after the plan, and a last line lists the plan. `backText(p)` → ", back around Nov 24".

## web/espn.js, server.py

- `client.loadInjuries()` → normalised report; never throws (empty on any failure). loadWeek and
  loadLeague call `applyInjuries` on every current roster and on the free agents.
- Free agents are asked for the `03` (last 30 days) split too; the stat ids follow `opts.season`.
- `GET /injuries` on the local server proxies the public report with a 15 minute cache and no cookies.
- Demo mode answers `injuries` with a small report for its hurt players.

## UI

- Scoreboard: win chance as a half dial between the scores, team records, "N% with your plan".
- "Your plan" section under the scoreboard: one row per move (day, pickup, drop, this week / next 3 weeks
  / total) and a card with the totals and the projected finish.
- Nights: played nights are compact tiles; night cards show the plan's moves ("In your plan"), a note
  for a real pending claim ("Claim day") and "Hold" with the this-week-only options folded.
- A waiver claim says when to enter it: "Enter this claim now, before Tue 08:00 WET. ESPN processes it
  then…" (`claimNoteHTML`, from `fa.waiverDate` in the viewer's time zone). The plan row shows the day
  the player joins.
- Injury chips carry the expected return; the row detail shows ESPN's note, minutes and the minutes trend.
- The view is in the address (`#trades`); the tabs stay at the top while scrolling; a button cycles the
  theme (system, light, dark; `wp:theme` in localStorage, `data-theme` on `<html>`).
- Section titles use the display face in capitals; a new week or view plays a short entrance once.
