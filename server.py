#!/usr/bin/env python3
"""Week planner: local server + ESPN proxy.

    python server.py [--port 8765] [--no-browser] [--check]

Python 3.8+, standard library only. Binds 127.0.0.1 only.

- Serves the static app from ./web (relative to this file, not the cwd).
- GET/POST /config   read / save config.json (espn_s2 is never returned).
- GET /espn/<rest>   proxy to the ESPN fantasy basketball API with the saved cookies.
- GET /injuries      ESPN's public NBA injury report (expected return dates). No cookies are sent.
"""
import argparse
import errno
import gzip
import hashlib
import json
import mimetypes
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

BASE_DIR = os.path.dirname(os.path.realpath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
CACHE_DIR = os.path.join(BASE_DIR, ".cache")

ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/"
INJURY_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
INJURY_TTL = 900  # seconds

# The Bets view: public NBA data and bookmaker odds. No cookies are sent to any of these.
NBA_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=%s&limit=200"
NBA_PROPS = ("https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/%s/competitions/%s"
             "/odds/100/propBets?limit=1000&pageSize=1000&page=%d")
NBA_GAMELOG = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/%s/gamelog?season=%d"
NBA_PLAYERS = ESPN_BASE + "seasons/%d/segments/0/leaguedefaults/3?view=kona_player_info"
BETANO_NBA = "https://www.betano.pt/api/sport/basquetebol/eua/nba/441g/?req=la,s,stnf,c,mb"
BETANO_EVENT = "https://www.betano.pt/api%s?bt=1&req=la,s,stnf,c,mb"
BETCLIC_NBA = "https://www.betclic.pt/basquetebol-sbasketball/nba-c13"
BETCLIC_BASE = "https://www.betclic.pt"
ODDS_TTL = 120  # seconds: lines move
GAMELOG_TTL = 1800  # the season in progress
PAST_TTL = 30 * 24 * 3600  # finished games and seasons
MAX_IDS = 400

# The Bets track record (web/picklog.js): personal, kept next to config.json and out of git.
PICKS_PATH = os.path.join(BASE_DIR, "data", "picks.json")
PICKS_MAX_BODY = 2 * 1024 * 1024
_picks_lock = threading.Lock()
DEFAULT_LEAGUE_ID = 1257343892
DEFAULT_PORT = 8765
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

DEFAULT_TTL = 20
MAX_TTL = 7 * 24 * 3600
DISK_MIN_TTL = 3600
MEM_MAX_ENTRIES = 600
UPSTREAM_TIMEOUT = 30
MAX_BODY = 64 * 1024

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}

_print_lock = threading.Lock()


def say(msg=""):
    """Print without ever crashing on a console that can't encode the text."""
    with _print_lock:
        try:
            sys.stdout.write(msg + "\n")
        except UnicodeEncodeError:
            enc = getattr(sys.stdout, "encoding", None) or "ascii"
            sys.stdout.write(msg.encode(enc, "replace").decode(enc, "replace") + "\n")
        try:
            sys.stdout.flush()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

_config_lock = threading.Lock()
GUID_RE = re.compile(r"^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")


def default_season():
    now = datetime.now()
    return now.year + 1 if now.month >= 8 else now.year


def _to_int(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    s = str(v).strip()
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    return None


def load_config():
    """Read config.json fresh each time (so hand edits apply without a restart)."""
    cfg = {
        "leagueId": DEFAULT_LEAGUE_ID,
        "season": default_season(),
        "teamId": None,
        "espn_s2": "",
        "swid": "",
        "leagues": [],  # every saved league: {leagueId, season, teamId, name}
    }
    error = None
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("top level must be a JSON object")
        lid = _to_int(raw.get("leagueId"))
        if lid:
            cfg["leagueId"] = lid
        season = _to_int(raw.get("season"))
        if season:
            cfg["season"] = season
        cfg["teamId"] = _to_int(raw.get("teamId"))
        cfg["espn_s2"] = str(raw.get("espn_s2") or "").strip()
        cfg["swid"] = str(raw.get("swid") or "").strip()
        for item in raw.get("leagues") or []:
            if isinstance(item, dict) and _to_int(item.get("leagueId")):
                cfg["leagues"].append({
                    "leagueId": _to_int(item.get("leagueId")),
                    "season": _to_int(item.get("season")) or cfg["season"],
                    "teamId": _to_int(item.get("teamId")),
                    "name": str(item.get("name") or "").strip()[:80],
                })
    except FileNotFoundError:
        pass
    except Exception as e:  # invalid JSON etc.
        error = "config.json could not be read (%s)" % e
    # The top-level league is the one in use; it is always in the list.
    if not any(l["leagueId"] == cfg["leagueId"] for l in cfg["leagues"]):
        cfg["leagues"].insert(0, {"leagueId": cfg["leagueId"], "season": cfg["season"], "teamId": cfg["teamId"], "name": ""})
    cfg["_error"] = error
    return cfg


def is_configured(cfg):
    return bool(cfg["espn_s2"] and cfg["swid"] and cfg["leagueId"])


def public_config(cfg):
    out = {
        "configured": is_configured(cfg),
        "leagueId": cfg["leagueId"],
        "season": cfg["season"],
        "teamId": cfg["teamId"],
        "swid": cfg["swid"],
        "hasS2": bool(cfg["espn_s2"]),
        "leagues": cfg["leagues"],
    }
    if cfg.get("_error"):
        out["error"] = cfg["_error"]
    return out


def save_config(cfg):
    data = {
        "leagueId": cfg["leagueId"],
        "season": cfg["season"],
        "teamId": cfg["teamId"],
        "espn_s2": cfg["espn_s2"],
        "swid": cfg["swid"],
        "leagues": cfg["leagues"],
    }
    tmp = CONFIG_PATH + ".tmp"
    with _config_lock:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, CONFIG_PATH)


class BadInput(Exception):
    pass


def norm_swid(value):
    s = unquote(str(value)).strip().strip("\"'")
    s = re.sub(r"^swid\s*=\s*", "", s, flags=re.I).rstrip(";").strip().strip("{}").strip()
    if GUID_RE.match(s):
        return "{" + s.upper() + "}"
    raise BadInput("SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}. Copy it exactly as shown in Chrome.")


def norm_s2(value):
    s = str(value).strip().strip("\"'")
    s = re.sub(r"^espn_s2\s*=\s*", "", s, flags=re.I).rstrip(";").strip()
    if len(s) < 20 or re.search(r"[\s;,]", s) or any(ord(c) < 33 or ord(c) > 126 for c in s):
        raise BadInput("espn_s2 looks wrong (it is a long value with no spaces). Copy it exactly as shown in Chrome.")
    return s


def parse_league(value):
    """Return (leagueId, seasonFromUrl|None) from a league URL or a plain id."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value, None
    s = str(value or "").strip()
    if not s:
        raise BadInput("Enter your league URL or league id.")
    if re.fullmatch(r"\d+", s):
        return int(s), None
    m = re.search(r"leagueId=(\d+)", s, re.I)
    if not m:
        m = re.search(r"/leagues?/(\d+)", s, re.I)
    if not m:
        raise BadInput("Could not find a leagueId in that URL. It should contain leagueId=<number>.")
    sm = re.search(r"seasonId=(\d{4})", s, re.I)
    return int(m.group(1)), (int(sm.group(1)) if sm else None)


def apply_config_update(body):
    cur = load_config()
    new = dict(cur)
    new.pop("_error", None)
    new["leagues"] = [dict(l) for l in cur["leagues"]]
    season_from_url = None
    league_val = body.get("league", body.get("leagueId"))
    if league_val not in (None, ""):
        new["leagueId"], season_from_url = parse_league(league_val)
        if new["leagueId"] != cur["leagueId"]:
            # Switching league: start from what was saved for it (or detect the team from SWID).
            saved = next((l for l in new["leagues"] if l["leagueId"] == new["leagueId"]), None)
            new["season"] = saved["season"] if saved else cur["season"]
            new["teamId"] = saved["teamId"] if saved else None
    if "season" in body and body["season"] not in (None, ""):
        season = _to_int(body["season"])
        if not season or not (2000 <= season <= 2100):
            raise BadInput("Season should be a year such as 2027 (the season ends in that year).")
        new["season"] = season
    elif season_from_url:
        new["season"] = season_from_url
    if "teamId" in body:
        tv = body["teamId"]
        if tv in (None, ""):
            new["teamId"] = None
        else:
            tid = _to_int(tv)
            if not tid or tid < 1 or tid > 100:
                raise BadInput("Team id should be a small number such as 6, or empty to detect it from SWID.")
            new["teamId"] = tid
    s2 = body.get("espn_s2")
    if s2 not in (None, ""):
        new["espn_s2"] = norm_s2(s2)
    swid = body.get("swid")
    if swid not in (None, ""):
        new["swid"] = norm_swid(swid)
    if not new["espn_s2"]:
        raise BadInput("espn_s2 is required.")
    if not new["swid"]:
        raise BadInput("SWID is required.")
    remove = _to_int(body.get("removeLeague"))
    if remove:
        new["leagues"] = [l for l in new["leagues"] if l["leagueId"] != remove]
        if remove == new["leagueId"]:
            if not new["leagues"]:
                raise BadInput("This is your only league. Add another one before removing it.")
            first = new["leagues"][0]
            new["leagueId"], new["season"], new["teamId"] = first["leagueId"], first["season"], first["teamId"]
    entry = next((l for l in new["leagues"] if l["leagueId"] == new["leagueId"]), None)
    if entry is None:
        entry = {"leagueId": new["leagueId"], "name": ""}
        new["leagues"].append(entry)
    entry["season"], entry["teamId"] = new["season"], new["teamId"]
    if isinstance(body.get("name"), str) and body["name"].strip():
        entry["name"] = body["name"].strip()[:80]
    save_config(new)
    return new


# --------------------------------------------------------------------------
# Cache (memory + disk for long TTLs)
# --------------------------------------------------------------------------

_cache_lock = threading.Lock()
_mem = {}  # key -> (expires_epoch, body_bytes)
_key_locks = {}  # key -> [Lock, refcount]


def cache_key(rest, query, flt, swid):
    h = hashlib.sha256()
    for part in (rest, query, flt or "", swid or ""):
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def _disk_path(key):
    return os.path.join(CACHE_DIR, key + ".bin")


def cache_get(key):
    now = time.time()
    with _cache_lock:
        ent = _mem.get(key)
        if ent and ent[0] > now:
            return ent[1], "hit-mem"
        if ent:
            _mem.pop(key, None)
    try:
        with open(_disk_path(key), "rb") as f:
            head, _, body = f.read().partition(b"\n")
        expires = float(json.loads(head.decode("utf-8"))["expires"])
        if expires > now and body:
            with _cache_lock:
                _mem[key] = (expires, body)
            return body, "hit-disk"
    except Exception:
        pass
    return None


def cache_put(key, body, ttl):
    if ttl <= 0:
        return
    expires = time.time() + ttl
    with _cache_lock:
        _mem[key] = (expires, body)
        if len(_mem) > MEM_MAX_ENTRIES:
            now = time.time()
            for k in [k for k, v in _mem.items() if v[0] <= now]:
                _mem.pop(k, None)
            if len(_mem) > MEM_MAX_ENTRIES:
                for k, _ in sorted(_mem.items(), key=lambda kv: kv[1][0])[: len(_mem) - int(MEM_MAX_ENTRIES * 0.8)]:
                    _mem.pop(k, None)
    if ttl >= DISK_MIN_TTL:
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            path = _disk_path(key)
            tmp = "%s.%d.tmp" % (path, threading.get_ident())
            with open(tmp, "wb") as f:
                f.write(json.dumps({"expires": expires}).encode("utf-8") + b"\n" + body)
            os.replace(tmp, path)
        except Exception:
            pass


def prune_disk_cache():
    try:
        now = time.time()
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            try:
                if name.endswith(".tmp"):
                    os.remove(path)
                    continue
                with open(path, "rb") as f:
                    head = f.readline()
                if float(json.loads(head.decode("utf-8"))["expires"]) <= now:
                    os.remove(path)
            except Exception:
                try:
                    os.remove(path)
                except Exception:
                    pass
    except Exception:
        pass


def _lock_for(key):
    with _cache_lock:
        ent = _key_locks.get(key)
        if ent is None:
            ent = _key_locks[key] = [threading.Lock(), 0]
        ent[1] += 1
        return ent


def _unlock_for(key, ent):
    with _cache_lock:
        ent[1] -= 1
        if ent[1] <= 0:
            _key_locks.pop(key, None)


# --------------------------------------------------------------------------
# ESPN fetch
# --------------------------------------------------------------------------


class EspnError(Exception):
    def __init__(self, status, code, message):
        Exception.__init__(self, message)
        self.status = status
        self.code = code
        self.message = message


def _decode_body(data, encoding):
    enc = (encoding or "").lower()
    if enc == "gzip" or data[:2] == b"\x1f\x8b":
        return gzip.decompress(data)
    if enc == "deflate":
        try:
            return zlib.decompress(data)
        except zlib.error:
            return zlib.decompress(data, -zlib.MAX_WBITS)
    return data


def _upstream(url, cfg, flt, cookies=True, accept="application/json"):
    headers = {
        "Accept": accept,
        "Accept-Encoding": "gzip",
        "User-Agent": USER_AGENT,
    }
    if cookies and cfg["espn_s2"] and cfg["swid"]:
        headers["Cookie"] = "espn_s2=%s; SWID=%s" % (cfg["espn_s2"], cfg["swid"])
    if flt:
        headers["x-fantasy-filter"] = flt
    try:
        req = urllib.request.Request(url, headers=headers)
    except (ValueError, UnicodeEncodeError):
        raise EspnError(400, "bad_request", "Request contained characters that cannot be sent as a header.")
    try:
        with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
            raw = resp.read()
            return _decode_body(raw, resp.headers.get("Content-Encoding"))
    except urllib.error.HTTPError as e:
        try:
            snippet = e.read(400).decode("utf-8", "replace")
        except Exception:
            snippet = ""
        if e.code in (401, 403):
            if cfg["espn_s2"] and cfg["swid"]:
                msg = "ESPN rejected the saved cookies (espn_s2 / SWID). Copy fresh ones."
            else:
                msg = "No ESPN cookies saved yet. Open the setup form and paste espn_s2 and SWID."
            raise EspnError(401, "espn_auth", msg)
        if e.code >= 500:
            raise EspnError(502, "espn_http", "ESPN returned HTTP %d. Try again in a minute." % e.code)
        raise EspnError(e.code, "espn_http", "ESPN returned HTTP %d. %s" % (e.code, snippet.strip()[:200]))
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        hint = ""
        if isinstance(reason, ssl.SSLError):
            hint = " (TLS problem: a corporate proxy may be re-signing HTTPS; see README, Troubleshooting)"
        else:
            hint = " (if you are behind a corporate proxy, set HTTPS_PROXY; see README)"
        raise EspnError(502, "network", "Could not reach ESPN: %s%s" % (reason, hint))
    except (socket.timeout, TimeoutError):
        raise EspnError(502, "network", "Timed out waiting for ESPN. Try again.")
    except (ConnectionError, OSError, ssl.SSLError, zlib.error, EOFError) as e:
        raise EspnError(502, "network", "Could not reach ESPN: %s" % e)


def parse_ttl(value):
    try:
        ttl = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TTL
    if ttl != ttl:  # NaN
        return DEFAULT_TTL
    return max(0, min(MAX_TTL, ttl))


def espn_get(rest, query, flt, ttl, cfg=None, use_cache=True, public_url=None):
    """Return (body_bytes, source) where source is hit-mem | hit-disk | miss.

    public_url: a fixed public ESPN address to fetch instead of the fantasy API. No cookies are sent
    to it and its cache entry is shared by every account.
    """
    if cfg is None:
        cfg = load_config()
    if public_url:
        url = public_url
        key = cache_key(rest, query, None, "public")
    else:
        if (
            ".." in rest
            or not re.fullmatch(r"[A-Za-z0-9_\-./]*", rest)
            or re.search(r"[\x00-\x20\x7f]", query)
        ):
            raise EspnError(400, "bad_request", "Invalid ESPN path.")
        url = ESPN_BASE + rest + ("?" + query if query else "")
        key = cache_key(rest, query, flt, cfg["swid"])
    if use_cache and ttl > 0:
        hit = cache_get(key)
        if hit:
            return hit
    ent = _lock_for(key)
    try:
        with ent[0]:
            if use_cache and ttl > 0:
                hit = cache_get(key)  # another thread may have filled it
                if hit:
                    return hit
            body = _upstream(url, cfg, flt, cookies=not public_url)
            first = body.lstrip()[:1]
            if first not in (b"{", b"["):
                raise EspnError(502, "bad_response", "ESPN returned something that is not JSON. Try again later.")
            if use_cache:
                cache_put(key, body, ttl)
            return body, "miss"
    finally:
        _unlock_for(key, ent)


# --------------------------------------------------------------------------
# Bets view: public sources (ESPN, DraftKings lines through ESPN, Betano, Betclic)
# --------------------------------------------------------------------------


def public_get(name, url, ttl, flt=None, transform=None, source="ESPN", accept="application/json"):
    """Fetch a public address without cookies, optionally reshape it, and cache the JSON result."""
    key = cache_key("public/" + name, "", flt, "public")
    if ttl > 0:
        hit = cache_get(key)
        if hit:
            return hit
    ent = _lock_for(key)
    try:
        with ent[0]:
            if ttl > 0:
                hit = cache_get(key)
                if hit:
                    return hit
            try:
                body = _upstream(url, {"espn_s2": "", "swid": ""}, flt, cookies=False, accept=accept)
            except EspnError as e:
                raise EspnError(e.status, e.code, e.message.replace("ESPN", source))
            if transform:
                body = transform(body)
            if body.lstrip()[:1] not in (b"{", b"["):
                raise EspnError(502, "bad_response", "%s returned something that is not JSON. Try again later." % source)
            if ttl > 0:
                cache_put(key, body, ttl)
            return body, "miss"
    finally:
        _unlock_for(key, ent)


def _slim_props(body):
    """DraftKings prop lines from ESPN, without the links: about a tenth of the size."""
    data = json.loads(body)
    items = []
    for it in data.get("items") or []:
        m = re.search(r"/athletes/(\d+)", ((it.get("athlete") or {}).get("$ref") or ""))
        odds = it.get("odds") or {}
        items.append({
            "athlete": {"$ref": "athletes/" + m.group(1)} if m else None,
            "type": it.get("type"),
            "odds": {"american": odds.get("american"), "total": odds.get("total")},
            "current": it.get("current"),
            "open": it.get("open"),
        })
    return json.dumps({"count": data.get("count"), "pageCount": data.get("pageCount"), "items": items}).encode("utf-8")


def _slim_gamelog(body):
    """An ESPN game log with only what the Bets view reads (WPBets.normGamelog)."""
    d = json.loads(body)
    evs = {}
    for k, e in (d.get("events") or {}).items():
        opp, team = e.get("opponent") or {}, e.get("team") or {}
        evs[k] = {"gameDate": e.get("gameDate"), "atVs": e.get("atVs"),
                  "opponent": {"id": opp.get("id"), "abbreviation": opp.get("abbreviation")},
                  "team": {"id": team.get("id"), "abbreviation": team.get("abbreviation")}}
    sts = [{"displayName": st.get("displayName"),
            "categories": [{"events": c.get("events") or []} for c in st.get("categories") or []]}
           for st in d.get("seasonTypes") or []]
    return json.dumps({"labels": d.get("labels"), "events": evs, "seasonTypes": sts}).encode("utf-8")


def _betclic_state(body):
    """Betclic has no public odds API, but each page carries its odds as JSON (Angular's ng-state)."""
    html = body.decode("utf-8", "replace")
    m = re.search(r'<script id="ng-state" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        raise EspnError(502, "bad_response", "Betclic changed its page: no odds found.")
    st = json.loads(m.group(1))
    return json.dumps({k: v for k, v in st.items() if k.startswith("grpc:")}).encode("utf-8")


def _ids(value):
    ids = [x for x in (value or "").split(",") if x]
    if not ids or len(ids) > MAX_IDS or not all(re.fullmatch(r"\d{1,10}", x) for x in ids):
        raise EspnError(400, "bad_request", "ids must be 1 to %d numbers separated by commas." % MAX_IDS)
    return ids


def _season(value):
    if not re.fullmatch(r"20\d\d", value or ""):
        raise EspnError(400, "bad_request", "season must be a year such as 2027.")
    return int(value)


def odds_get(sub, q):
    """Answer /odds/<sub>. Returns (body, source)."""
    one = lambda k: (q.get(k) or [""])[0]
    if sub == "scoreboard":
        date = one("date")
        if not re.fullmatch(r"\d{8}", date):
            raise EspnError(400, "bad_request", "date must be YYYYMMDD.")
        past = date < (datetime.utcnow() - timedelta(days=2)).strftime("%Y%m%d")
        return public_get("sb/" + date, NBA_SCOREBOARD % date, PAST_TTL if past else ODDS_TTL)
    if sub == "props":
        ev = one("event")
        if not re.fullmatch(r"\d{6,12}", ev):
            raise EspnError(400, "bad_request", "event must be an ESPN game id.")
        first, src = public_get("props/%s/1" % ev, NBA_PROPS % (ev, ev, 1), ODDS_TTL, transform=_slim_props, source="ESPN odds")
        data = json.loads(first)
        for page in range(2, min(int(data.get("pageCount") or 1), 6) + 1):
            more, _ = public_get("props/%s/%d" % (ev, page), NBA_PROPS % (ev, ev, page), ODDS_TTL,
                                 transform=_slim_props, source="ESPN odds")
            data["items"].extend(json.loads(more)["items"])
        return json.dumps(data).encode("utf-8"), src
    if sub == "gamelogs":
        season, ids = _season(one("season")), _ids(one("ids"))
        ttl = GAMELOG_TTL if season >= default_season() else PAST_TTL

        def fetch(pid):
            try:
                body, _ = public_get("gl/%d/%s" % (season, pid), NBA_GAMELOG % (pid, season), ttl, transform=_slim_gamelog)
                return pid, json.loads(body)
            except Exception:
                return pid, None  # a player without a log this season; the rest still load

        with ThreadPoolExecutor(8) as pool:
            out = dict(pool.map(fetch, ids))
        return json.dumps(out).encode("utf-8"), "mixed"
    if sub == "players":
        season, ids = _season(one("season")), _ids(one("ids"))
        flt = json.dumps({"players": {"filterIds": {"value": [int(x) for x in ids]}, "limit": len(ids),
                                      "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                                      "filterStatsForSourceIds": {"value": [0, 1]},
                                      "filterStatsForSplitTypeIds": {"value": [0]}}})
        return public_get("players/%d/%s" % (season, ",".join(sorted(ids))), NBA_PLAYERS % season, GAMELOG_TTL, flt=flt,
                          source="ESPN fantasy")
    if sub == "betano":
        return public_get("betano/nba", BETANO_NBA, ODDS_TTL, source="Betano", accept="application/json, text/plain, */*")
    if sub == "betano/event":
        path = one("path")
        if not re.fullmatch(r"/odds/[a-z0-9-]{3,120}/\d{4,12}/", path):
            raise EspnError(400, "bad_request", "path must be a Betano game address such as /odds/a-b/123/.")
        return public_get("betano/" + path, BETANO_EVENT % path, ODDS_TTL, source="Betano",
                          accept="application/json, text/plain, */*")
    if sub == "betclic":
        return public_get("betclic/nba", BETCLIC_NBA, ODDS_TTL, transform=_betclic_state, source="Betclic",
                          accept="text/html,application/xhtml+xml")
    if sub == "betclic/event":
        path = one("path")
        if not re.fullmatch(r"/basquetebol-sbasketball/nba-c13/[a-z0-9-]{3,120}-m\d{6,20}", path):
            raise EspnError(400, "bad_request", "path must be a Betclic NBA game address.")
        return public_get("betclic/" + path, BETCLIC_BASE + path, ODDS_TTL, transform=_betclic_state, source="Betclic",
                          accept="text/html,application/xhtml+xml")
    raise EspnError(404, "not_found", "Unknown odds address.")


class PicksError(Exception):
    pass


def load_picks():
    """{"version": 1, "picks": {id: record}}. A file that cannot be read is an error, never an empty
    log: saving over it would lose the track record."""
    try:
        with open(PICKS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"version": 1, "picks": {}}
    except (OSError, ValueError) as e:
        raise PicksError("data/picks.json could not be read (%s). Fix or move it; nothing was changed." % e.__class__.__name__)
    if not isinstance(data, dict) or not isinstance(data.get("picks"), dict):
        raise PicksError("data/picks.json is not a track record. Fix or move it; nothing was changed.")
    return data


def save_picks(upsert, remove):
    with _picks_lock:
        data = load_picks()
        for rec in upsert:
            data["picks"][rec["id"]] = rec
        for pid in remove:
            data["picks"].pop(pid, None)
        os.makedirs(os.path.dirname(PICKS_PATH), exist_ok=True)
        tmp = "%s.%d.tmp" % (PICKS_PATH, threading.get_ident())
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, PICKS_PATH)
        return len(data["picks"])


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WeekPlanner/1.0"
    timeout = 60

    # ---- plumbing ----
    def log_message(self, fmt, *args):  # silence default logging (static files are noise)
        pass

    def _port(self):
        return self.server.server_address[1]

    def _send(self, status, body, ctype, extra=None, head=False):
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if extra:
                for k, v in extra.items():
                    self.send_header(k, v)
            self.end_headers()
            if not head and self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout):
            self.close_connection = True

    def _json(self, status, obj, extra=None):
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8", extra)

    def _error(self, status, code, message):
        self._json(status, {"error": code, "message": message})

    def _allowed_origins(self):
        p = self._port()
        return {"http://127.0.0.1:%d" % p, "http://localhost:%d" % p, "http://[::1]:%d" % p}

    def _host_ok(self):
        host = self.headers.get("Host")
        if not host:
            return True
        host = host.lower()
        p = self._port()
        return host in ("127.0.0.1:%d" % p, "localhost:%d" % p, "[::1]:%d" % p)

    def _guard_api(self):
        """Block requests that did not come from this app's own page."""
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self._allowed_origins():
            self._error(403, "forbidden_origin", "Requests from other sites are not allowed.")
            return False
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            self._error(403, "forbidden_origin", "Requests from other sites are not allowed.")
            return False
        return True

    # ---- routing ----
    def _route(self):
        if not self._host_ok():
            self._error(403, "forbidden_host", "This server only answers on 127.0.0.1 / localhost.")
            return
        parts = urlsplit(self.path)
        path = parts.path
        if path == "/config":
            if not self._guard_api():
                return
            if self.command == "POST":
                self._post_config()
            elif self.command in ("GET", "HEAD"):
                self._json(200, public_config(load_config()))
            else:
                self._error(405, "method_not_allowed", "Use GET or POST.")
            return
        if path.startswith("/espn/") or path == "/espn":
            if self.command not in ("GET", "HEAD"):
                self._error(405, "method_not_allowed", "Use GET.")
                return
            if not self._guard_api():
                return
            self._proxy(path[len("/espn/"):], parts.query)
            return
        if path == "/injuries":
            if self.command not in ("GET", "HEAD"):
                self._error(405, "method_not_allowed", "Use GET.")
                return
            if not self._guard_api():
                return
            self._proxy("injuries", "", public_url=INJURY_URL)
            return
        if path == "/picks":
            if not self._guard_api():
                return
            if self.command == "POST":
                self._post_picks()
            elif self.command in ("GET", "HEAD"):
                try:
                    self._json(200, load_picks())
                except PicksError as e:
                    self._error(500, "picks_unreadable", str(e))
            else:
                self._error(405, "method_not_allowed", "Use GET or POST.")
            return
        if path.startswith("/odds/"):
            if self.command not in ("GET", "HEAD"):
                self._error(405, "method_not_allowed", "Use GET.")
                return
            if not self._guard_api():
                return
            self._odds(path[len("/odds/"):], parts.query)
            return
        if self.command not in ("GET", "HEAD"):
            self._error(405, "method_not_allowed", "Use GET.")
            return
        self._static(path)

    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._error(405, "method_not_allowed", "Use GET or POST.")

    do_DELETE = do_PATCH = do_OPTIONS = do_PUT

    # ---- /config ----
    def _post_config(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self._error(400, "bad_request", "Send a JSON body (up to 64 KB).")
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            self._error(400, "bad_request", "Body must be a JSON object.")
            return
        try:
            apply_config_update(body)
        except BadInput as e:
            self._error(400, "invalid_config", str(e))
            return
        except OSError as e:
            self._error(500, "write_failed", "Could not write config.json: %s" % e.strerror)
            return
        say("[%s] config.json saved (league %s)" % (datetime.now().strftime("%H:%M:%S"), load_config()["leagueId"]))
        self._json(200, public_config(load_config()))

    # ---- /picks ----
    def _post_picks(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0 or length > PICKS_MAX_BODY:
            self._error(400, "bad_request", "Send a JSON body (up to 2 MB).")
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            upsert = body.get("upsert") or []
            remove = body.get("remove") or []
            if not isinstance(upsert, list) or not isinstance(remove, list):
                raise ValueError("lists expected")
            for rec in upsert:
                if not isinstance(rec, dict) or not isinstance(rec.get("id"), str) or not 0 < len(rec["id"]) <= 300:
                    raise ValueError("every record needs a string id")
            if not all(isinstance(x, str) for x in remove):
                raise ValueError("remove takes ids")
        except Exception:
            self._error(400, "bad_request", 'Body must be {"upsert": [records with an id], "remove": [ids]}.')
            return
        try:
            count = save_picks(upsert, remove)
        except PicksError as e:
            self._error(500, "picks_unreadable", str(e))
            return
        except OSError as e:
            self._error(500, "write_failed", "Could not write data/picks.json: %s" % e.strerror)
            return
        self._json(200, {"ok": True, "count": count})

    # ---- /espn ----
    def _proxy(self, rest, query, public_url=None):
        t0 = time.time()
        ttl = INJURY_TTL if public_url else parse_ttl(self.headers.get("x-cache-ttl"))
        flt = None if public_url else self.headers.get("x-fantasy-filter")
        if flt is not None:
            flt = flt.replace("\r", "").replace("\n", "").strip()
            if len(flt) > 8192:
                self._error(400, "bad_request", "x-fantasy-filter is too long.")
                return
        try:
            body, src = espn_get(rest, query, flt or None, ttl, public_url=public_url)
        except EspnError as e:
            self._log_espn(e.status, "err", rest, query, t0)
            self._json(e.status, {"error": e.code, "message": e.message})
            return
        except Exception as e:  # never leak a traceback page
            self._log_espn(500, "err", rest, query, t0)
            self._json(500, {"error": "server_error", "message": "Unexpected error: %s" % e.__class__.__name__})
            return
        self._log_espn(200, src, rest, query, t0)
        self._send(200, body, "application/json; charset=utf-8", {"X-WP-Cache": src})

    def _odds(self, sub, query):
        t0 = time.time()
        try:
            body, src = odds_get(sub, parse_qs(query))
        except EspnError as e:
            self._log_espn(e.status, "err", "odds/" + sub, query, t0)
            self._json(e.status, {"error": e.code, "message": e.message})
            return
        except Exception as e:  # never leak a traceback page
            self._log_espn(500, "err", "odds/" + sub, query, t0)
            self._json(500, {"error": "server_error", "message": "Unexpected error: %s" % e.__class__.__name__})
            return
        self._log_espn(200, src, "odds/" + sub, query, t0)
        self._send(200, body, "application/json; charset=utf-8", {"X-WP-Cache": src})

    def _log_espn(self, status, src, rest, query, t0):
        if src == "hit-mem":
            return  # keep the console readable
        short = rest.split("/leagues/")[-1] if "/leagues/" in rest else rest
        q = re.sub(r"%[0-9A-Fa-f]{2}", "", query)
        line = "[%s] ESPN %d %-8s %.2fs  %s?%s" % (
            datetime.now().strftime("%H:%M:%S"), status, src, time.time() - t0, short, q)
        say(line[:140])

    # ---- static ----
    def _static(self, path):
        if not os.path.isdir(WEB_DIR):
            self._send(404, b"The web/ folder was not found next to server.py.", "text/plain; charset=utf-8")
            return
        rel = unquote(path)
        if "\x00" in rel or "\\" in rel or ":" in rel:
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        segs = [s for s in rel.split("/") if s not in ("", ".")]
        if any(s == ".." or s.startswith(".") for s in segs):
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        root = os.path.realpath(WEB_DIR)
        target = os.path.realpath(os.path.join(root, *segs)) if segs else root
        try:
            inside = os.path.commonpath([root, target]) == root
        except ValueError:
            inside = False
        if not inside:
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        try:
            with open(target, "rb") as f:
                data = f.read()
        except OSError:
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        ext = os.path.splitext(target)[1].lower()
        ctype = CONTENT_TYPES.get(ext) or mimetypes.guess_type(target)[0] or "application/octet-stream"
        self._send(200, data, ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server bind the same port silently.
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout)):
            return  # browser closed the connection; not worth a traceback
        say("Unexpected error while handling a request: %s" % exc.__class__.__name__)


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


def team_label(t):
    name = (t.get("name") or "").strip()
    if not name:
        name = ("%s %s" % (t.get("location", ""), t.get("nickname", ""))).strip()
    return name or "Team %s" % t.get("id")


def run_check():
    cfg = load_config()
    if cfg.get("_error"):
        say("Problem: " + cfg["_error"])
        return 1
    say("Config: leagueId %s, season %s, cookies %s, %d league(s) saved" % (
        cfg["leagueId"], cfg["season"], "saved" if is_configured(cfg) else "missing", len(cfg["leagues"])))
    if not is_configured(cfg):
        say("Not configured. Start the server and fill in the setup form, or edit config.json "
            "(see config.example.json).")
        return 1
    failed = 0
    for lg in cfg["leagues"]:
        say("")
        failed += check_league(cfg, lg)
    return 1 if failed else 0


def check_league(cfg, lg):
    rest = "seasons/%d/segments/0/leagues/%d" % (lg["season"], lg["leagueId"])
    try:
        body, _ = espn_get(rest, "view=mSettings&view=mTeam&view=mStatus", None, 0, cfg, use_cache=False)
        data = json.loads(body.decode("utf-8"))
    except EspnError as e:
        say("FAILED: " + e.message)
        return 1
    except ValueError:
        say("FAILED: ESPN returned a response that could not be read.")
        return 1
    settings = data.get("settings") or {}
    teams = data.get("teams") or []
    status = data.get("status") or {}
    say("League: %s (%s teams, %s)" % (
        settings.get("name", "?"), len(teams), (settings.get("scoringSettings") or {}).get("scoringType", "?")))
    if status.get("currentMatchupPeriod") is not None:
        say("Current matchup period: %s, scoring period: %s" % (
            status.get("currentMatchupPeriod"), data.get("scoringPeriodId", status.get("latestScoringPeriod", "?"))))
    swid = cfg["swid"].strip("{}").lower()
    mine = None
    for t in teams:
        owners = [str(o).strip("{}").lower() for o in (t.get("owners") or [])]
        is_me = swid in owners
        if is_me:
            mine = t
        say("  %2s  %s%s" % (t.get("id"), team_label(t), "   <- you (SWID match)" if is_me else ""))
    if mine is None and not lg["teamId"]:
        say("Warning: no team matches your SWID and teamId is not set. Set teamId in config.json.")
    say("OK")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Week planner: local server and ESPN proxy.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="port to listen on (default %d)" % DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser on start")
    ap.add_argument("--check", action="store_true", help="test the saved cookies against ESPN and exit")
    args = ap.parse_args()

    if args.check:
        return run_check()

    if not (1 <= args.port <= 65535):
        say("Port must be between 1 and 65535.")
        return 2
    try:
        httpd = Server(("127.0.0.1", args.port), Handler)
    except OSError as e:
        if e.errno in (errno.EADDRINUSE, 98, 48, 10048):
            say("Port %d is already in use. Is the planner already running? "
                "Close it, or start with --port %d." % (args.port, args.port + 1))
        else:
            say("Could not start the server on 127.0.0.1:%d: %s" % (args.port, e))
        return 2

    prune_disk_cache()
    cfg = load_config()
    url = "http://127.0.0.1:%d" % args.port
    say("Week planner running at %s — Ctrl+C to stop" % url)
    if cfg.get("_error"):
        say("Warning: " + cfg["_error"])
    if is_configured(cfg):
        say("League %s, season %s, cookies saved. Run with --check to test them." % (cfg["leagueId"], cfg["season"]))
    else:
        say("Not configured yet: the browser will show the setup form. "
            "(Or copy config.example.json to config.json and fill it in.)")
    if not os.path.isdir(WEB_DIR):
        say("Warning: web/ folder not found at %s" % WEB_DIR)

    if not args.no_browser:
        def _open():
            try:
                webbrowser.open(url)
            except Exception:
                pass
        t = threading.Timer(0.6, _open)
        t.daemon = True
        t.start()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        say("\nStopped.")
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
