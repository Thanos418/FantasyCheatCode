"""Build per-game projection factors from public ESPN data.

    python tools/build_factors.py [--season 2026] [--current 2027] [--players 300]

Writes web/factors.js (global WPFactors, also require()-able) with:
  home / away      fantasy output at home vs away, relative to the player's season average
  opp[ABBREV]      output against each opponent: last season's, moved towards this season's games
  b2bOutput        output on the second night of a back-to-back
  b2bPlay          chance of playing on that night, relative to a normal night
Fantasy points use ESPN's default points scoring; only ratios are kept, so they carry over to
other points scorings. Finished seasons are cached in .cache/gamelogs/; the season in progress is
read fresh, so rerun this every week or so to keep the opponents current.
Stdlib only.
"""
import argparse
import datetime
import gzip
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/'
GAMELOG = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{}/gamelog?season={}'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

MIN_GP = 20        # player needs this many games to have a stable average
MIN_AVG = 15.0     # and at least this many fantasy points per game
OPP_SHRINK = 150   # player-games of evidence needed to move an opponent factor halfway
MIN_GP_CURRENT = 5    # same as MIN_GP, for the season in progress
CURRENT_SHRINK = 75   # player-games this season needed to move an opponent halfway from last season's factor


def get_json(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json',
                                               'Accept-Encoding': 'gzip', **(headers or {})})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
                return json.loads(body)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))


def top_players(season, limit):
    filt = {'players': {'limit': limit, 'sortPercOwned': {'sortPriority': 1, 'sortAsc': False},
                        'filterSlotIds': {'value': [0, 1, 2, 3, 4, 5, 6, 11]}}}
    data = get_json(FANTASY + 'seasons/%d/segments/0/leaguedefaults/3?view=kona_player_info' % season,
                    {'x-fantasy-filter': json.dumps(filt)})
    return [p['id'] for p in data['players']]


def team_schedule(season):
    """{gameId: sp} and {teamId: set(sp)} for the regular season."""
    data = get_json(FANTASY + 'seasons/%d?view=proTeamSchedules_wl' % season)
    game_sp, team_sps = {}, {}
    for t in data['settings']['proTeams']:
        if not t['id']:
            continue
        for sp, games in (t.get('proGamesByScoringPeriod') or {}).items():
            for g in games:
                game_sp[str(g['id'])] = int(sp)
                team_sps.setdefault(t['id'], set()).add(int(sp))
    return game_sp, team_sps


def gamelog(pid, season, cache=True):
    path = os.path.join(ROOT, '.cache', 'gamelogs', '%d-%s.json' % (season, pid))
    if cache and os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    raw = get_json(GAMELOG.format(pid, season))
    games = []
    for st in raw.get('seasonTypes', []):
        if 'Regular Season' not in st.get('displayName', ''):
            continue
        for cat in st.get('categories', []):
            for e in cat.get('events', []):
                ev = raw['events'].get(e['eventId'])
                if not ev:
                    continue
                games.append({'id': e['eventId'], 'team': int(ev['team']['id']),
                              'opp': ev['opponent']['abbreviation'], 'home': ev['atVs'] != '@',
                              'stats': e['stats']})
    if cache:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(games, f)
    return games


def fantasy_points(stats):
    # labels: MIN, FG, FG%, 3PT, 3P%, FT, FT%, REB, AST, BLK, STL, PF, TO, PTS
    fgm, fga = map(int, stats[1].split('-'))
    tpm = int(stats[3].split('-')[0])
    ftm, fta = map(int, stats[5].split('-'))
    reb, ast, blk, stl, to, pts = (int(float(stats[i])) for i in (7, 8, 9, 10, 12, 13))
    return pts + tpm + reb + 2 * ast + 4 * stl + 4 * blk - 2 * to + 2 * fgm - fga + ftm - fta


def measure(season, limit, min_gp, cache):
    """Add up one season's game logs: (sums, play counts, players used, game ids not in the schedule)."""
    game_sp, team_sps = team_schedule(season)
    pids = top_players(season, limit)
    print('Reading %d game logs for %d...' % (len(pids), season), file=sys.stderr)
    with ThreadPoolExecutor(8) as pool:
        logs = list(pool.map(lambda pid: gamelog(pid, season, cache), pids))

    sums = {}  # key -> [fantasy points, expected points, player-games]

    def add(key, fp, avg):
        s = sums.setdefault(key, [0.0, 0.0, 0])
        s[0] += fp
        s[1] += avg
        s[2] += 1

    played = {'b2b': [0, 0], 'rest': [0, 0]}  # [played, team games] while on that team
    players = unmatched = 0
    for games in logs:
        unmatched += sum(1 for g in games if g['id'] not in game_sp)
        games = [g for g in games if g['id'] in game_sp]
        if len(games) < min_gp:
            continue
        fps = [fantasy_points(g['stats']) for g in games]
        avg = sum(fps) / len(fps)
        if avg < MIN_AVG:
            continue
        players += 1
        for g, fp in zip(games, fps):
            sp = game_sp[g['id']]
            b2b = (sp - 1) in team_sps.get(g['team'], ())
            add('all', fp, avg)
            add('home' if g['home'] else 'away', fp, avg)
            add('opp:' + g['opp'], fp, avg)
            if b2b:
                add('b2b', fp, avg)
        # Play rate: every team game between his first and last game for that team.
        by_team = {}
        for g in games:
            by_team.setdefault(g['team'], set()).add(game_sp[g['id']])
        for team, sps in by_team.items():
            for sp in team_sps.get(team, ()):
                if min(sps) <= sp <= max(sps):
                    kind = 'b2b' if (sp - 1) in team_sps[team] else 'rest'
                    played[kind][1] += 1
                    played[kind][0] += sp in sps
    return sums, played, players, unmatched


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--season', type=int, default=2026, help='last finished ESPN season (2026 = 2025-26)')
    ap.add_argument('--current', type=int, help='season in progress (default: the one after --season)')
    ap.add_argument('--players', type=int, default=300, help='how many of the most rostered players to sample')
    args = ap.parse_args()
    current = args.current or args.season + 1

    sums, played, players, unmatched = measure(args.season, args.players, MIN_GP, True)
    ratio = lambda k: sums[k][0] / sums[k][1]
    base = ratio('all')
    opp = {}
    for key, (fp, exp, n) in sums.items():
        if key.startswith('opp:'):
            raw = (fp / exp) / base
            opp[key[4:]] = 1 + (raw - 1) * n / (n + OPP_SHRINK)

    # Defenses change from year to year: this season's games move each team away from last season's number.
    cur_sums, _, _, _ = measure(current, args.players, MIN_GP_CURRENT, False)
    cur_games = 0
    if 'all' in cur_sums:
        cur_base = cur_sums['all'][0] / cur_sums['all'][1]
        cur_games = cur_sums['all'][2]
        for key, (fp, exp, n) in cur_sums.items():
            if key.startswith('opp:') and key[4:] in opp:
                raw = (fp / exp) / cur_base
                opp[key[4:]] += (raw - opp[key[4:]]) * n / (n + CURRENT_SHRINK)

    rate = {k: v[0] / v[1] for k, v in played.items()}
    out = {
        'measuredOn': args.season,
        'currentSeason': current,
        'currentGames': cur_games,
        'built': datetime.date.today().isoformat(),
        'players': players,
        'games': sums['all'][2],
        'home': round(ratio('home') / base, 4),
        'away': round(ratio('away') / base, 4),
        'b2bOutput': round(ratio('b2b') / base, 4),
        'b2bPlay': round(rate['b2b'] / rate['rest'], 4),
        'playRates': {'rest': round(rate['rest'], 4), 'b2b': round(rate['b2b'], 4)},
        'opp': {k: round(v, 4) for k, v in sorted(opp.items())},
    }
    js = ('/* Generated by tools/build_factors.py from public ESPN game logs. Do not edit. */\n'
          '(function (root) {\n  var F = ' + json.dumps(out, indent=2).replace('\n', '\n  ') + ';\n'
          "  if (typeof module === 'object' && module.exports) module.exports = F;\n"
          "  root.WPFactors = F;\n"
          "})(typeof self !== 'undefined' ? self : globalThis);\n")
    with open(os.path.join(ROOT, 'web', 'factors.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    print(json.dumps({k: v for k, v in out.items() if k != 'opp'}, indent=1))
    print('opp range %.3f - %.3f; game ids not in schedule: %d' % (min(opp.values()), max(opp.values()), unmatched))


if __name__ == '__main__':
    main()
