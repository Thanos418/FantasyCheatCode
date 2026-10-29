# Week planner

A local week planner for an ESPN fantasy basketball points league. It replicates League Winner's Weekly Slate from ESPN data: games edge against your opponent, a night-by-night view with open lineup slots and the best add, a roster grid with real and projected points, and a streaming board. It runs on your own computer and reads your league through a small local server.

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

## Running

```
python server.py --check     # test the saved cookies against ESPN, print league and team names, exit
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

`tools/digest.js` prints the morning facts as plain text, one per line: the week score, your win chance, how many of your players play today, injuries, role changes and the best add. It needs Node 18 or newer (nothing to install) and reads `config.json` for the league and your ESPN cookies. It asks ESPN directly, so the local server does not have to be running.

```
node tools/digest.js          # your league
node tools/digest.js --demo   # fake league, no cookies needed
```

If the cookies are missing or ESPN rejects them, it says so and exits with code 1. The cookies are never printed. To get the digest every morning, run it from a scheduled task (Task Scheduler on Windows, cron on macOS/Linux). It keeps a small cache in `.cache/`, so repeat runs make few requests.

## Projections

Each player's points per game blend his current-season average with ESPN's season projection (ESPN's projection weighs more early in the season). Each upcoming game then adjusts that number:

| Factor | Effect (2025-26 data) |
|---|---|
| Home / away | ×1.012 / ×0.988 |
| Opponent | ×0.90 (BOS) to ×1.10, shrunk towards 1 |
| Second night of a back-to-back | ×1.009 output, ×0.923 chance of playing |

The factors live in `web/factors.js`. They come from last season's public ESPN game logs for the 300 most rostered players. To rebuild them:

```
python tools/build_factors.py            # --season 2026 --players 300 are the defaults
```

Game logs are cached in `.cache/gamelogs/`. In category leagues the factors are off, so values are game counts.

## Tests

```
node --test
```

## Privacy

`config.json` holds your ESPN cookies. It is listed in `.gitignore`, stays on your machine, and the cookies are only ever sent to ESPN, by the local server. The responses cache in `.cache/` (also ignored). Do not commit or share `config.json`.

## Files

| Path | What it is |
|---|---|
| `server.py` | Local server: static files, `/config`, and a proxy to the ESPN API with your cookies. |
| `config.example.json` | Template for `config.json`. |
| `start.bat`, `start.sh` | Launchers for Windows and macOS/Linux. |
| `web/index.html` | Page shell. |
| `web/app.js` | UI: renders the scoreboard, nights, roster grid and streaming board. |
| `web/styles.css` | Styles, light and dark. |
| `web/model.js` | Pure logic: weeks, projections, lineup matching, recommendations. |
| `web/espn.js` | Data layer: fetches and normalises ESPN responses. |
| `web/demo-data.js` | Fake ESPN responses for `?demo`. |
| `web/factors.js` | Per-game factors (venue, opponent, back-to-back), generated. |
| `tools/build_factors.py` | Rebuilds `web/factors.js` from public ESPN game logs. |
| `tools/digest.js` | Daily digest for the command line or a scheduled task (`node tools/digest.js`). |
| `tests/` | Tests for the model (`node --test`). |
| `SPEC.md` | Build spec and ESPN API notes. |
