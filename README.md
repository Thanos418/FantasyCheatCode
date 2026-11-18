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
| Bets | Tonight's NBA player props at Betano and Betclic, priced against DraftKings, with the research behind each pick. |

Win chance comes from simulating the rest of the week 5,000 times with per-game spread, rest days, day-to-day players, starters who sit without warning and uncertainty about each player's level. Those settings were fitted on 2025-26 with the backtest and checked on 2024-25.

Each view has its own address (`#week`, `#playoffs`, `#trends`, `#trades`, `#league`, `#bets`), so reload, Back and bookmarks land on it. The half-moon button in the top bar switches between the system theme, light and dark.

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

### Bets

The Bets view lists every player prop for tonight's games (or tomorrow's) at Betano and Betclic and says which ones pay more than they should.

- **The fair price** comes from DraftKings' line, read through ESPN, with the bookmaker's margin taken off. Overs are then marked down: this season they went over less often than DraftKings priced them, by 2.5 points on points, 3.5 on PRA and 4 on steals (fitted per stat on 16,146 closing lines). A distribution fitted on the same lines turns that into a chance for every line and every ladder rung ("25+").
- **Value** is a book paying more than those fair odds: Betano or Betclic still on an old line, a different line, or a ladder rung priced off its own line. The list ranks bets by expected value (the extra you expect back per euro), with a stake of a quarter Kelly, at most 2.5% of your bankroll. With no value, it shows the closest bets and the odds another book would need to pay.
- **DK moved** marks a value bet on the side DraftKings has moved towards since it opened (its line changed, or its chance of the over by 4 points or more), at a book that still pays the old price. These come first in the list. In the opening-lines backtest, the old line on that side returned +6.7% at DraftKings' margin.
- **Early** marks a line DraftKings has not moved since it opened. Its opening price has not taken in what the close will, and our projection sees some of it coming, so while it is early the projection counts for more: rebounds 20%, assists 30%, 3s 25%, steals 40%, blocks 30%, rebounds + assists 15% (points and the other combos stay on the market alone).
- **The research** under each pick: every book's price for that player and stat, the chance of each total, his last 10 games against the line, hit rates (last 5, last 10, season, last season, against tonight's opponent), how much of that stat the opponent gives up to his position (and its rank), the game total, spread and back-to-backs, minutes and shots lately, splits without teammates who are out tonight, DraftKings' line movement, and our own projection.
- **Check a price** takes any book's line and odds (Placard, Solverde, ESC Online…) and gives the fair odds, the chance and the expected value.
- DraftKings is the reference and is not bettable from Portugal; the "All" book filter shows it anyway. Ladder rungs and lines far from the main line are shown but not ranked: the backtest only checked rungs up to about one standard deviation away. A price far below our chance (usually a different bet read as this one) is never ranked either.

The research is there to read, not to bet on: in the backtest neither our projections nor matchup or hit-rate rules beat DraftKings' closing line (see Backtest). Once DraftKings has moved, our projection moves the fair price only for rebounds, the one stat where it held its own against the close out of sample.

#### Track record

Every value pick the view shows at Betano or Betclic goes into a track record the moment it appears, with its price and edge then (and its latest price until tip-off). The day after, each pick is graded from the box score (won, lost, push, or void when he did not play) and priced against DraftKings' closing line. **Track record** (next to Tonight and Tomorrow) shows:

- profit at one unit a pick, the return with its 95% range, and what the edges promised when the picks were logged;
- closing-line value: what each pick was worth at DraftKings' closing price after the same corrections. Results need hundreds of bets to mean much; a positive average here shows an edge much sooner;
- breakdowns by book, stat and kind of bet, by how long before tip-off the pick was logged, and by what DraftKings had done by then (moved towards it, not moved yet, other), a running total by night, and every pick;
- **your bets**: open a pick, enter your stake and press "I placed this"; they are counted in euros, at the price you took.

The record lives in `data/picks.json` (kept out of git). Picks are logged when the view loads a night, so a night you never open is missing. To log every night anyway, run the command-line version from a scheduled task, after DraftKings has its lines and before the first game (23:00 in Lisbon works):

```
node tools/picks.js            # grade what finished and print the track record
node tools/picks.js log        # log tonight's value picks first
```

```
schtasks /Create /TN "FantasyCheatCode picks" /SC DAILY /ST 23:00 /TR "node C:\Users\olive\Downloads\fantasy-week-planner\tools\picks.js log"
```

It goes through the local server when it is running. Without it, it reads the sources itself, and Betano refuses those requests, so that night has Betclic's picks only. Grading needs only ESPN.

Betano and Betclic have no public API. The local server reads Betano's own JSON pages and the odds Betclic embeds in its game pages, no more often than every two minutes, without cookies. Betclic's rebounds and assists only load inside its live page, so from Betclic the view has points and PRA. Either site can change its pages or block the requests; the view then says so ("refused the request") and carries on with the others. Some networks are refused outright, a work network for one: run it from home.

#### Price history

Betano and Betclic keep no price history, so `tools/snapshots.js` keeps one: every few minutes it reads tonight's board and appends every price that changed (DraftKings, Betano, Betclic) to `data/snapshots/<date>.jsonl` (kept out of git). Each run also logs the value picks into the track record, as the view does when it is open, so with it running you no longer need the `picks.js log` task.

```
node tools/snapshots.js --every 10     # a snapshot every 10 minutes until tonight's last game starts
node tools/snapshots.js report         # every finished night on file
```

Run it on game days from about 18:00 in Lisbon, with the local server running (Betano only answers through it):

```
schtasks /Create /TN "FantasyCheatCode snapshots" /SC DAILY /ST 18:00 /TR "node C:\path\to\FantasyCheatCode\tools\snapshots.js --every 10"
```

The report takes every value price seen at Betano or Betclic, the first time it appeared, and gives how many there are a night, how long each stayed on offer, its value against DraftKings' closing line and its results: overall, by book, by time before tip-off, for prices that were value right after DraftKings moved, and for ladders. That is the test the opening-lines backtest could not run. The Bets view is worth betting on if the closing-line value stays above about +2% with its range above zero over a few hundred prices, with a few a night.

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

The Bets view has its own factors, by stat and by position (how many points, rebounds, assists, 3s, steals and blocks each defence gives up to guards, forwards and centers), in `web/statfactors.js`. Last season sets them and this season's games move them. Rebuild them every week or so too:

```
node tools/build_stat_factors.js         # --players 300 is the default for this season's sample
```

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

### Bets backtest

`tools/backtest_props.js` checks the Bets view the same way, through `web/bets.js`. Part 1 fits the stat projections on every 2025-26 game of about 400 players, with 2024-25 as the prior, and checks them on 2024-25. Part 2 takes DraftKings' closing player lines, which ESPN keeps for the season in progress (from 21 Oct 2026; earlier seasons are gone), and tests everything out of sample (fitted on even days, tested on odd days and the other way round).

```
node tools/backtest_props.js             # both parts; the first run reads a few thousand ESPN pages, later runs about a minute
node tools/backtest_props.js --market    # part 2 only, with the settings in web/bets.js
```

What it found (16,146 DraftKings closing lines, 21 Oct to 16 Nov 2026):

| | Result |
|---|---|
| Our projections against a player's season average so far | 2 to 3% closer, both seasons |
| Our projections against DraftKings' closing line | worse for every stat but steals (log loss 0.72 v 0.69 on points) |
| Overs, all stats | went over 47.5% of the time when the price said 49.9% |
| Ladder rungs a few steps from the line, after the corrections | within about a point of what happened |

Betting every pick at DraftKings' closing odds, 1 unit each (± is a 95% range):

| Rule | Bets | ROI |
|---|---|---|
| Our projections alone, edge of 5% or more | 8,221 | −5.7% ± 2.1% |
| Linemaker: over against the 5 defences that give up the most of that stat to his position, under against the 5 that give up the least | 2,557 | −6.2% ± 3.7% |
| Hit rate: over after 7 or more overs in his last 10, under after 3 or fewer | 1,646 | −11.2% ± 4.4% |
| Corrected market alone, edge of 0% or more | 2,771 | −1.8% ± 3.6% |
| Every under | 16,146 | −2.6% ± 1.4% |
| Every over | 16,146 | −10.0% ± 1.5% |

DraftKings' margin on these lines averaged 6.7%. Nothing beat its closing line, which is why the Bets view looks for value in prices at other books rather than in projections. Those prices cannot be backtested: Betano and Betclic keep no history.

### Opening lines backtest

ESPN also keeps DraftKings' opening line and price. `tools/backtest_open.js` compares them with the close (the first run reads about a thousand ESPN pages, later runs take seconds):

```
node tools/backtest_open.js
```

What it found (21,494 DraftKings main lines, 20 Oct to 17 Nov 2026; ± is a 95% range):

| | Result |
|---|---|
| Lines whose line changed between open and close | 37% (over 50% for points and the combos, under 11% for 3s, steals and blocks) |
| A book still at DraftKings' opening price, value of 0%+ / 4%+ / 10%+ against the corrected close | +7.0% / +11.3% / +19.0% return, against +7.2% / +11.2% / +17.4% promised (10,949 / 6,275 / 2,672 bets) |
| The same at 3%+ with 2, 4 or 6 points more margin than DraftKings | +10.7%, +11.1%, +10.6% |
| The opening line on the side DraftKings moved towards | +6.7% ± 2.0% at DraftKings' margin, +4.8% with 2 points more, +2.9% with 4 more |
| Our projection against the opening line (rebounds, assists, 3s, steals, blocks, R+A), value 2%+ | closing-line value +2.1% ± 0.9%, return +4.4% ± 7.2% (792 bets) |
| The same with 2 points more margin | closing-line value +1.4% ± 1.4% |

Two things follow. The corrected closing line is a fair price that holds on lines other than DraftKings' own: when it says a price has value, the value comes back as profit. And a book that lags DraftKings pays: the question is only how often Betano and Betclic do, which is what the price history measures. Our projection beats DraftKings' opening line by a little in the stats where it has a weight, enough for a book with DraftKings' margin, not much more.

## Tests

```
node --test
```

## Privacy

`config.json` holds your ESPN cookies. It is listed in `.gitignore`, stays on your machine, and the cookies are only ever sent to ESPN's fantasy API, by the local server. The Bets view's requests (ESPN's public pages, Betano, Betclic) carry no cookies. The responses cache in `.cache/` (also ignored). Do not commit or share `config.json`.

## Files

| Path | What it is |
|---|---|
| `server.py` | Local server: static files, `/config`, a proxy to the ESPN API with your cookies, ESPN's public injury report, `/odds/*` for the Bets view (no cookies), and `/picks` for its track record (`data/picks.json`). |
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
| `web/bets.js` | Pure logic for the Bets view: book parsers, stat projections, distributions, prices, the night's board, research. |
| `web/odds.js` | Data layer for the Bets view: schedule, DraftKings, Betano, Betclic, game logs, injuries. |
| `web/bets-view.js` | The Bets view. |
| `web/statfactors.js` | Defence by stat and position, generated. |
| `tools/build_stat_factors.js` | Rebuilds `web/statfactors.js`. |
| `tools/backtest_props.js`, `tools/props_data.js` | The Bets backtest and its data. |
| `web/picklog.js` | The Bets track record: logging, grading, closing-line value, summary. |
| `tools/picks.js` | The track record from the command line (`node tools/picks.js [log]`). |
| `tools/snapshots.js` | Price history of tonight's board, and its report (`node tools/snapshots.js [--every 10 \| report]`). |
| `tools/backtest_open.js` | DraftKings' opening lines against its closing lines; fits `weightEarly`. |
| `tools/build_factors.py` | Rebuilds `web/factors.js` from public ESPN game logs. |
| `tools/backtest.js` | Replays past seasons through the app's code (`node tools/backtest.js`). |
| `tools/digest.js` | Daily digest for the command line or a scheduled task (`node tools/digest.js`). |
| `tests/` | Tests for the model (`node --test`). |
| `SPEC.md` | Build spec and ESPN API notes. |
