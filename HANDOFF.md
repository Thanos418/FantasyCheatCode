# Handoff — continue here in Claude Code

Read `SPEC.md` first. It is the full contract: what League Winner's "Weekly Slate" does, the ESPN API
facts verified live on this league (endpoints, filters, stat ids, the All-Star merged week), every
module's interface, the algorithms, and the visual direction.

## State (Oct 29 2026, 18:10)

| File | State |
|---|---|
| `SPEC.md` | done — source of truth |
| `server.py` | done, compiles, smoke-tested: `/config`, static files, path traversal blocked, `/espn/*` proxy returns clean JSON errors. Not yet tested against ESPN with real cookies (the cloud sandbox couldn't reach ESPN). |
| `config.example.json`, `.gitignore`, `start.bat`, `start.sh` | done |
| `web/index.html` | done (loads model.js, espn.js, demo-data.js, app.js, styles.css) |
| `web/app.js` | written in full (1,056 lines, parses), **never run** — model.js/espn.js didn't exist yet. Expect integration bugs. |
| `web/model.js` | **missing** — pure logic (`WPModel`), see SPEC "Module contract" |
| `web/espn.js` | **missing** — data layer (`WPData`), see SPEC "Data layer contract" |
| `web/demo-data.js` | **missing** — fake ESPN responses for `?demo` (optional; real data is better now) |
| `web/styles.css` | **missing** — tokens and visual direction are in SPEC "Visual direction" |
| `tests/model.test.js` | **missing** — `node --test tests/` |
| `README.md` | **missing** |

## Suggested order

1. `web/model.js` + `tests/model.test.js` (test cases listed in SPEC: week mapping with the All-Star merge,
   lineup matching with position constraints, projections, computeWeek, recommendations).
2. `web/espn.js`.
3. Copy `config.example.json` → `config.json`, paste `espn_s2` and `SWID` from Chrome DevTools
   (Application → Cookies → https://fantasy.espn.com), run `python server.py --check`, then `python server.py`.
4. Get `web/app.js` running against real data; write `web/styles.css`.
5. Check the numbers against League Winner for week 2 (see below), then README.md.
6. Create the private GitHub repo and push: `gh repo create Thanos418/fantasy-week-planner --private --source=. --push`.

## Reference numbers to verify against (week 2, Oct 26 – Nov 1, seen Thu Oct 29)

- Games per team: 4 = ATL BOS CHA CLE GSW HOU IND LAL MIN; 2 = PHX; everyone else 3.
  NBA games per night: Mon 9, Tue 4, Wed 12, Thu 3, Fri 10, Sat 7, Sun 4.
- Matchup: Thanos was right (team 6) vs Lebrontocracy (team 4). ESPN points by day: me 206.4 / 94 / 241,
  opp 127 / 202.4 / 317.2.
- League Winner showed per-day games me v opp: 7v7, 5v6, 10v10, 3v2, 10v7, 4v7, 5v1 (22 left v 17).
  Note: it counted Mitchell Robinson's Monday game although he wasn't on the roster yet. From ESPN's
  day rosters Monday is 6 for me; trust ESPN.
- Adds: league limit is 1 per day (`matchupLimitPerScoringPeriod: true`); 2 used this week; one pending
  waiver claim (ADD 4432194 / DROP 4576060).
