#!/usr/bin/env python3
"""Week planner: local server + ESPN proxy.

    python server.py [--port 8765] [--no-browser] [--check]

Python 3.8+, standard library only. Binds 127.0.0.1 only.

- Serves the static app from ./web (relative to this file, not the cwd).
- GET/POST /config   read / save config.json (espn_s2 is never returned).
- GET /espn/<rest>   proxy to the ESPN fantasy basketball API with the saved cookies.
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
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

BASE_DIR = os.path.dirname(os.path.realpath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
CACHE_DIR = os.path.join(BASE_DIR, ".cache")

ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/"
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


def _upstream(url, cfg, flt):
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": USER_AGENT,
    }
    if cfg["espn_s2"] and cfg["swid"]:
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


def espn_get(rest, query, flt, ttl, cfg=None, use_cache=True):
    """Return (body_bytes, source) where source is hit-mem | hit-disk | miss."""
    if cfg is None:
        cfg = load_config()
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
            body = _upstream(url, cfg, flt)
            first = body.lstrip()[:1]
            if first not in (b"{", b"["):
                raise EspnError(502, "bad_response", "ESPN returned something that is not JSON. Try again later.")
            if use_cache:
                cache_put(key, body, ttl)
            return body, "miss"
    finally:
        _unlock_for(key, ent)


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

    # ---- /espn ----
    def _proxy(self, rest, query):
        t0 = time.time()
        ttl = parse_ttl(self.headers.get("x-cache-ttl"))
        flt = self.headers.get("x-fantasy-filter")
        if flt is not None:
            flt = flt.replace("\r", "").replace("\n", "").strip()
            if len(flt) > 8192:
                self._error(400, "bad_request", "x-fantasy-filter is too long.")
                return
        try:
            body, src = espn_get(rest, query, flt or None, ttl)
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
