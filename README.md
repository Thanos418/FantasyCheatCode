# Week planner

A local week planner for an ESPN fantasy basketball points league. It replicates League Winner's Weekly Slate from ESPN data: games edge against your opponent, a night-by-night view with open lineup slots and the best add, a roster grid with real and projected points, and a streaming board. It runs on your own computer and reads your league through a small local server.

## Views

| View | What it shows |
|---|---|
| This week | Score, projected finish and your win chance; the week plan; games edge; night cards; roster grid; streaming board. |
| Playoffs | Games per playoff round for your players, every NBA team and the best free agents, with expected points. |
| Trends | Last 7 and 15 games against the season and ESPN's projection, minutes and starts, then buy-low and sell-high lists from the whole league. |
| Trades | Analyzer for any trade with any team (both sides, next 4 weeks and rest of season, forced drops), and trade ideas that help both teams. |
| League | Power rankings: record, points for, projected strength a week and remaining schedule. |

Win chance comes from simulating the rest of the week 5,000 times with per-game spread, rest days, day-to-day players, starters who sit without warning and uncertainty about each player's level. Those settings were fitted on 2025-26 with the backtest and checked on 2024-25.

Each view has its own address (`#week`, `#playoffs`, `#trends`, `#trades`, `#league`), so reload, Back and bookmarks land on it. The half-moon button in the top bar switches between the system theme, light and dark.

### Add suggestions and the week plan

Every move is judged by two numbers: points gained this week (extra games in your lineup) and what the pickup and the player you drop are expected to score over the next 3 weeks (their real games and opponents, allowing for missed games). A move is worth making when the two add up to a gain, so a clear long-term upgrade is suggested even when it adds nothing this week.

**Your plan** puts the moves in order: the best one, then the best one with that move already made, and so on, until nothing is worth it or the week's adds run out. No player is dropped twice and each gain is on top of the ones before it. The plan is remade on every refresh. Night cards show the plan's moves for that night; a night without one is a "Hold", with the best pickup for this week only folded underneath.

Each move is listed under the day it takes effect:

- A free agent is picked up on a night he plays. A pickup made for the weeks ahead waits until the last day of the week, so the player dropped still plays his games.
- A waiver claim is listed under the day it processes, with the deadline spelled out ("Enter this claim now, before Tue 08:00"). You enter it before that; ESPN processes it when waivers clear.
- A player on IR who can play again shows up as "Activate from IR", with the drop that makes room. It uses no add.

The add limit is a budget for the whole matchup week. ESPN's "1 per scoring period" setting means 7 for a 7-day week, and several can be made on the same day; the app counts adds made plus pending claims against it.

- Pending waiver claims are respected: their pickup is not suggested again and their drop is never suggested.
- A waiver claim counts from the morning waivers process, so the player you would drop is gone from that day, even if the pickup's first game is later.
- The number of IR slots comes from ESPN. When one is free and a rostered player is Out, an add needs no drop and the card says who to move to IR; a trade for an Out player does not force a drop.
- An injured player counts again from ESPN's expected return date, at 75% for the games this week. An injured free agent is only suggested from that date. The chip next to the name shows it ("OUT · Wed", "OUT · Nov 24").

## Requirements

- Python 3.8 or newer. Nothing else to install: the server uses only the standard library and the front end has no build step.
- Node is only needed to run the tests and the daily digest.

## Setup

Either use the in-app setup screen (start the server, the browser shows a form), or copy the example config yourself:

```
cp config.example.json config.json     # Windows: copy config.example.json config.json
```

Then fill in `espn_s2` and `swid` in `config.json`. `leagueId`, `season` and `teamId` are already set for the default league; `teamId` can be left `null` and is found from your SWID.

### Getting espn_s2 and SWID

1. Sign in to ESPN Fantasy in Chrome and open `https://fantasy.espn.com/basketball`.
2. Open DevTools (F12, or Option+Command+I on a Mac) and go to Application, then Cookies, then `https://fantasy.espn.com`.
3. Copy the values of `espn_s2` (long string) and `SWID` (looks like `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`).

The cookies expire after a while. When ESPN answers 401, copy fresh ones and save again.

### Several leagues

Your cookies belong to your ESPN account, so they work for every ESPN league you play in. To add one, open the league name in the top bar and choose **Add a league…**, then paste the league link. The same menu switches between saved leagues; the app opens the last one you used. Your team in each league is found from your SWID (or set it in the form), and each league keeps its own team id in `config.json` (`leagues`).

## Running

```
python server.py --check     # test the saved cookies against every saved league, print league and team names, exit
python server.py             # start the server and open http://127.0.0.1:8765
```

`start.bat` (Windows) and `start.sh` (macOS/Linux) run `server.py` and pass extra arguments through.

| Flag | Meaning |
|---|---|
| `--port N` | Port to listen on (default 8765). The server binds 127.0.0.1 only. |
| `--no-browser` | Do not open the browser on start. |
| `--check` | Test the saved cookies against ESPN and exit (exit code 0 on success, 1 on failure). |

### Demo mode

Open `http://127.0.0.1:8765/?demo` to see the app on fake data. No cookies and no ESPN access needed.

## Daily digest

`tools/digest.js` prints the morning facts as plain text, one per line: the week score, your win chance, how many of your players play today, injuries with expected return dates, role changes, today's move and the week plan. It needs Node 18 or newer (nothing to install) and reads `config.json` for the league and your ESPN cookies. It asks ESPN directly, so the local server does not have to be running.

```
node tools/digest.js                 # the league in use
node tools/digest.js --league 12345  # another saved league, by id or part of its name
node tools/digest.js --all           # every saved league
node tools/digest.js --demo          # fake league, no cookies needed
```

If the cookies are missing or ESPN rejects them, it says so and exits with code 1. The cookies are never printed. To get the digest every morning, run it from a scheduled task (Task Scheduler on Windows, cron on macOS/Linux). It keeps a small cache in `.cache/`, so repeat runs make few requests.

## Projections

Each player's points per game are a weighted average of this season's games and ESPN's season projection:

| Part | Weight |
|---|---|
| ESPN's season projection | Counts as 10 games |
| Games from the last 15 days | Count three times |
| Games from 16 to 30 days ago | Count twice |
| Older games | Count once |
| Minutes over the last 15 days against the season | Move the number half as far as the minutes moved |

Each upcoming game then adjusts that number:

| Factor | Effect (2025-26 data) |
|---|---|
| Home / away | ×1.012 / ×0.988 |
| Opponent | Last season's defense, moved towards this season's as games are played |
| Second night of a back-to-back | ×1.009 output, ×0.923 chance of playing |

The factors live in `web/factors.js`. They come from public ESPN game logs for the 300 most rostered players, last season and this one. Rerun this every week or so to keep the opponents current:

```
python tools/build_factors.py            # --season 2026 --current 2027 --players 300 are the defaults
```

Finished seasons are cached in `.cache/gamelogs/`; the season in progress is read fresh. In category leagues the factors are off, so values are game counts.

Values that look more than a week ahead (the next 3 weeks of a pickup, trades, power rankings) also allow for missed games: a player's own share of team games played this season, pulled towards the usual 85%. They count an injured player from ESPN's expected return date, which the app reads from ESPN's public injury report through the local server (`/injuries`, no cookies sent). That report is ESPN's own estimate and tends to be optimistic.

## Backtest

`tools/backtest.js` replays finished NBA seasons through the app's own code, using only what was known before each game. It needs Node 18 or newer and public ESPN data; no cookies.

```
node tools/backtest.js                # 2025-26 and 2024-25, 10 and 16 teams, 3 simulated leagues each (allow about 20 minutes)
node tools/backtest.js --quick        # one season, 10 teams, one league (about a minute)
node tools/backtest.js --seasons 2026 --teams 12 --leagues 5 --players 400
```

| Question | How it is tested |
|---|---|
| How far off are the per-game projections, and which recipe is closest? | Every game of the season, real results |
| Do real games, opponents and an allowance for missed games beat an average schedule over the next 3 weeks? | Every player, every week, real results |
| When the app says 70%, do you win 70% of the time? | Simulated leagues |
| Does following the week plan beat standing still, and the simpler strategies? | Simulated leagues |

Your real leagues did not exist in those seasons, and ESPN keeps no past free-agent pools or daily injury lists, so the last two run on simulated leagues: rosters drafted from ESPN's preseason projections, the other teams stand still, nobody competes for free agents, adds are capped at 7 a week, and a player counts as out after missing his team's last 2 games. Treat those add-suggestion results as a ranking of strategies, not as points you would really gain. Fantasy points use ESPN's default points scoring.

### What it found (Nov 2026)

Projections, real results:

| Measure | 2025-26 | 2024-25 |
|---|---|---|
| Points off per game, every game counting the same | 10.31 | 10.43 |
| Points off per game, recent games and minutes (the app) | 10.13 | 10.29 |
| The same with each game's venue, opponent and rest | 10.10 | 10.26 |
| Next 3 weeks, points off, real games only | 86.2 | 83.6 |
| Next 3 weeks, points off, missed games allowed for (the app) | 70.2 | 69.6 |
| Picks the better of two players over those weeks | 73.5% to 76.1% | 74.3% to 75.9% |

Simulated leagues, points a week gained over never adding anyone (adds a week in brackets):

| Strategy | 2025-26, 10 teams | 2025-26, 16 teams | 2024-25, 10 teams | 2024-25, 16 teams |
|---|---|---|---|---|
| The week plan (the app) | +380.7 (5.7) | +333.6 (5.0) | +313.9 (5.4) | +335.8 (4.8) |
| Every night the top add is worth it | +305.1 (5.4) | +306.7 (5.1) | +276.6 (5.2) | +312.2 (5.0) |
| Best add every night, this week only | +281.2 (6.3) | +313.2 (6.3) | +305.1 (6.3) | +333.4 (6.2) |
| Only the single best move of the week | +254.1 (2.9) | +271.0 (2.7) | +239.1 (2.8) | +281.2 (2.6) |
| Win chance, average gap between forecast and result | 2.7% | 2.3% | 3.2% | 3.2% |

The plan scores most in all four setups: clearly in two, by a few points in the other two (the ranges overlap there). On average it gains +341 a week against +308 for adding the best player every night for this week alone. Two things to keep in mind. The plan may make several moves on one day, as ESPN allows, while the other three strategies make at most one a day. And the simulation is kind to every strategy that drops players freely, because nobody else picks them up.

## Tests

```
node --test
```

## Privacy

`config.json` holds your ESPN cookies. It is listed in `.gitignore`, stays on your machine, and the cookies are only ever sent to ESPN, by the local server. The responses cache in `.cache/` (also ignored). Do not commit or share `config.json`.

## Files

| Path | What it is |
|---|---|
| `server.py` | Local server: static files, `/config`, a proxy to the ESPN API with your cookies, and ESPN's public injury report. |
| `config.example.json` | Template for `config.json`. |
| `start.bat`, `start.sh` | Launchers for Windows and macOS/Linux. |
| `web/index.html` | Page shell. |
| `web/app.js` | UI: renders the scoreboard, nights, roster grid and streaming board. |
| `web/styles.css` | Styles, light and dark. |
| `web/model.js` | Pure logic: weeks, projections, injuries, lineup matching, recommendations, the week plan. |
| `web/espn.js` | Data layer: fetches and normalises ESPN responses. |
| `web/demo-data.js` | Fake ESPN responses for `?demo`. |
| `web/insights.js` | Pure logic for win chance, playoffs, trends, trades, power rankings and the digest. |
| `web/factors.js` | Per-game factors (venue, opponent, back-to-back), generated. |
| `tools/build_factors.py` | Rebuilds `web/factors.js` from public ESPN game logs. |
| `tools/backtest.js` | Replays past seasons through the app's code (`node tools/backtest.js`). |
| `tools/digest.js` | Daily digest for the command line or a scheduled task (`node tools/digest.js`). |
| `tests/` | Tests for the model (`node --test`). |
| `SPEC.md` | Build spec and ESPN API notes. |
