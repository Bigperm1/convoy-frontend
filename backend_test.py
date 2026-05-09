"""Backend tests for Rev Radar / Convoy API.

Focus: GET /api/feed/external multi-feed (na/row) support + sanity checks
for /api/auth/login and /api/voice/transcribe. Uses public Expo backend URL
from frontend/.env (EXPO_PUBLIC_BACKEND_URL) — never localhost.
"""
import os
import sys
import time
import json
import re
from pathlib import Path

import requests

# --- Resolve base URL from frontend/.env ---
FRONTEND_ENV = Path("/app/frontend/.env")
BASE_URL = None
if FRONTEND_ENV.exists():
    for line in FRONTEND_ENV.read_text().splitlines():
        m = re.match(r"^\s*EXPO_PUBLIC_BACKEND_URL\s*=\s*(.+?)\s*$", line)
        if m:
            BASE_URL = m.group(1).strip().strip('"').strip("'")
            break
if not BASE_URL:
    print("FATAL: EXPO_PUBLIC_BACKEND_URL not found in frontend/.env")
    sys.exit(1)

API = f"{BASE_URL.rstrip('/')}/api"
print(f"[INFO] Using API base: {API}")

DEMO_EMAIL = "demo@revradar.app"
DEMO_PASS = "demo1234"

results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}")
    results.append({"name": name, "ok": ok, "detail": detail})


def test_login_sanity():
    try:
        r = requests.post(
            f"{API}/auth/login",
            json={"email": DEMO_EMAIL, "password": DEMO_PASS},
            timeout=15,
        )
    except Exception as e:
        record("auth/login sanity", False, f"request error: {e}")
        return None
    if r.status_code != 200:
        record("auth/login sanity", False, f"status={r.status_code} body={r.text[:200]}")
        return None
    try:
        data = r.json()
    except Exception as e:
        record("auth/login sanity", False, f"non-json response: {e}")
        return None
    token = data.get("token")
    user = data.get("user", {})
    if not token or not user.get("email"):
        record("auth/login sanity", False, f"missing token/user: {data}")
        return None
    record(
        "auth/login sanity",
        True,
        f"got token len={len(token)} user.email={user.get('email')}",
    )
    return token


def test_feed_unauth():
    try:
        r = requests.get(f"{API}/feed/external", params={"feeds": "na"}, timeout=15)
    except Exception as e:
        record("feed/external auth gate (no token → 401)", False, f"request error: {e}")
        return
    if r.status_code == 401:
        record(
            "feed/external auth gate (no token → 401)",
            True,
            f"status=401 detail={r.text[:120]}",
        )
    else:
        record(
            "feed/external auth gate (no token → 401)",
            False,
            f"expected 401, got {r.status_code} body={r.text[:200]}",
        )


REQUIRED_KEYS = {
    "alerts",
    "count",
    "fetched_at",
    "source",
    "upstream_status",
    "upstream_error",
    "feeds",
}
ALLOWED_UPSTREAM_STATUSES = {"ok", "partial", "http_error", "network_error", "parse_error"}
ALLOWED_FEED_STATUSES = {"ok", "http_error", "network_error", "parse_error"}


def _validate_shape(data, label, expected_feed_keys=None, expected_feed_count=None):
    """Validate response shape. expected_feed_keys is a set of allowed keys
    (e.g. {"na"} or {"na","row"}); expected_feed_count is the expected len."""
    missing = REQUIRED_KEYS - set(data.keys())
    if missing:
        record(
            f"feed/external shape ({label})",
            False,
            f"missing keys: {missing}; got keys={list(data.keys())}",
        )
        return False
    if not isinstance(data["alerts"], list):
        record(
            f"feed/external shape ({label})",
            False,
            f"'alerts' is not a list: {type(data['alerts'])}",
        )
        return False
    if not isinstance(data["count"], int):
        record(
            f"feed/external shape ({label})",
            False,
            f"'count' is not int: {type(data['count'])}",
        )
        return False
    if data["count"] != len(data["alerts"]):
        record(
            f"feed/external shape ({label})",
            False,
            f"count={data['count']} != len(alerts)={len(data['alerts'])}",
        )
        return False
    if data["upstream_status"] not in ALLOWED_UPSTREAM_STATUSES:
        record(
            f"feed/external shape ({label})",
            False,
            f"upstream_status invalid: {data['upstream_status']}",
        )
        return False
    fa = data.get("fetched_at")
    if not isinstance(fa, str) or "T" not in fa:
        record(
            f"feed/external shape ({label})",
            False,
            f"fetched_at not iso8601-ish: {fa}",
        )
        return False
    feeds = data.get("feeds")
    if not isinstance(feeds, list):
        record(
            f"feed/external shape ({label})",
            False,
            f"feeds is not a list: {type(feeds)}",
        )
        return False
    if expected_feed_count is not None and len(feeds) != expected_feed_count:
        record(
            f"feed/external shape ({label})",
            False,
            f"expected feeds len={expected_feed_count}, got {len(feeds)} -> {feeds}",
        )
        return False
    for f in feeds:
        if not isinstance(f, dict):
            record(f"feed/external shape ({label})", False, f"feed entry not dict: {f}")
            return False
        for k in ("key", "url", "status", "error", "count"):
            if k not in f:
                record(
                    f"feed/external shape ({label})",
                    False,
                    f"feed entry missing key '{k}': {f}",
                )
                return False
        if f["status"] not in ALLOWED_FEED_STATUSES:
            record(
                f"feed/external shape ({label})",
                False,
                f"feed entry status invalid: {f['status']}",
            )
            return False
        if expected_feed_keys is not None and f["key"] not in expected_feed_keys:
            record(
                f"feed/external shape ({label})",
                False,
                f"feed key {f['key']!r} not in expected {expected_feed_keys}",
            )
            return False
    record(
        f"feed/external shape ({label})",
        True,
        f"count={data['count']} upstream_status={data['upstream_status']} "
        f"feeds={[(f['key'], f['status'], f['count']) for f in feeds]}",
    )
    return True


def _get_feed(token, params, label):
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.get(f"{API}/feed/external", headers=headers, params=params, timeout=20)
    except Exception as e:
        record(f"feed/external {label}", False, f"request error: {e}")
        return None
    if r.status_code != 200:
        record(
            f"feed/external {label}",
            False,
            f"expected 200, got {r.status_code} body={r.text[:300]}",
        )
        return None
    try:
        data = r.json()
    except Exception as e:
        record(f"feed/external {label}", False, f"non-json: {e}")
        return None
    record(
        f"feed/external {label}",
        True,
        f"status=200 alerts_len={len(data.get('alerts', []))} feeds={[f['key'] for f in data.get('feeds', [])]}",
    )
    return data


def test_feed_na_only(token):
    data = _get_feed(token, {"feeds": "na"}, "?feeds=na (200)")
    if data is None:
        return None
    _validate_shape(data, "feeds=na", expected_feed_keys={"na"}, expected_feed_count=1)
    feeds = data.get("feeds", [])
    if len(feeds) == 1 and feeds[0].get("key") == "na":
        record("feed/external feeds=na key check", True, f"feeds[0].key=='na' url={feeds[0].get('url')}")
    else:
        record(
            "feed/external feeds=na key check",
            False,
            f"feeds={feeds}",
        )
    return data


def test_feed_row_only(token):
    data = _get_feed(token, {"feeds": "row"}, "?feeds=row (200)")
    if data is None:
        return None
    _validate_shape(data, "feeds=row", expected_feed_keys={"row"}, expected_feed_count=1)
    feeds = data.get("feeds", [])
    if len(feeds) == 1 and feeds[0].get("key") == "row":
        record("feed/external feeds=row key check", True, f"feeds[0].key=='row' url={feeds[0].get('url')}")
    else:
        record("feed/external feeds=row key check", False, f"feeds={feeds}")
    return data


def test_feed_na_row(token):
    data = _get_feed(token, {"feeds": "na,row"}, "?feeds=na,row (200)")
    if data is None:
        return None
    _validate_shape(
        data,
        "feeds=na,row",
        expected_feed_keys={"na", "row"},
        expected_feed_count=2,
    )
    feeds = data.get("feeds", [])
    keys = {f.get("key") for f in feeds}
    if keys == {"na", "row"}:
        record(
            "feed/external feeds=na,row keys check",
            True,
            f"feed keys = {keys}",
        )
    else:
        record(
            "feed/external feeds=na,row keys check",
            False,
            f"expected keys {{'na','row'}}, got {keys}",
        )
    # overall must NOT be 5xx; status must be one of allowed values
    if data.get("upstream_status") in {"ok", "partial", "http_error", "network_error", "parse_error"}:
        record(
            "feed/external feeds=na,row overall status not 5xx",
            True,
            f"upstream_status={data.get('upstream_status')}",
        )
    else:
        record(
            "feed/external feeds=na,row overall status not 5xx",
            False,
            f"upstream_status={data.get('upstream_status')}",
        )
    return data


def test_feed_invalid(token):
    data = _get_feed(token, {"feeds": "invalid"}, "?feeds=invalid (200, fallback to na)")
    if data is None:
        return None
    _validate_shape(data, "feeds=invalid", expected_feed_keys={"na"}, expected_feed_count=1)
    feeds = data.get("feeds", [])
    if len(feeds) == 1 and feeds[0].get("key") == "na":
        record(
            "feed/external feeds=invalid fallback to na",
            True,
            f"feeds[0].key=='na' (default)",
        )
    else:
        record(
            "feed/external feeds=invalid fallback to na",
            False,
            f"feeds={feeds}",
        )


def test_feed_no_param(token):
    data = _get_feed(token, None, "no-param (default 200)")
    if data is None:
        return None
    _validate_shape(data, "no-param", expected_feed_keys={"na"}, expected_feed_count=1)
    feeds = data.get("feeds", [])
    if len(feeds) == 1 and feeds[0].get("key") == "na":
        record(
            "feed/external no-param defaults to na",
            True,
            f"feeds[0].key=='na'",
        )
    else:
        record(
            "feed/external no-param defaults to na",
            False,
            f"feeds={feeds}",
        )


def test_feed_cache_same_set(token, prev):
    """Second ?feeds=na,row call within ~1s should return identical fetched_at."""
    if prev is None:
        record(
            "feed/external cache (?feeds=na,row identical fetched_at)",
            False,
            "no previous response to compare",
        )
        return
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.get(
            f"{API}/feed/external",
            headers=headers,
            params={"feeds": "na,row"},
            timeout=20,
        )
    except Exception as e:
        record(
            "feed/external cache (?feeds=na,row identical fetched_at)",
            False,
            f"request error: {e}",
        )
        return
    if r.status_code != 200:
        record(
            "feed/external cache (?feeds=na,row identical fetched_at)",
            False,
            f"expected 200 got {r.status_code}",
        )
        return
    data = r.json()
    if data.get("fetched_at") == prev.get("fetched_at"):
        record(
            "feed/external cache (?feeds=na,row identical fetched_at)",
            True,
            f"fetched_at matched: {data['fetched_at']}",
        )
    else:
        record(
            "feed/external cache (?feeds=na,row identical fetched_at)",
            False,
            f"fetched_at differs: prev={prev.get('fetched_at')} now={data.get('fetched_at')}",
        )


def test_feed_cache_different_keys(token, na_data, na_row_data):
    """?feeds=na and ?feeds=na,row must be cached separately. We can't
    reliably compare fetched_at (TTL is 25s and order varies), but both
    responses must show distinct feed sets (len 1 vs 2)."""
    if na_data is None or na_row_data is None:
        record(
            "feed/external cache separation (?feeds=na vs ?feeds=na,row)",
            False,
            "missing prior responses",
        )
        return
    na_keys = {f.get("key") for f in na_data.get("feeds", [])}
    nr_keys = {f.get("key") for f in na_row_data.get("feeds", [])}
    if na_keys == {"na"} and nr_keys == {"na", "row"}:
        record(
            "feed/external cache separation (?feeds=na vs ?feeds=na,row)",
            True,
            f"distinct cache entries: na_keys={na_keys} nr_keys={nr_keys}",
        )
    else:
        record(
            "feed/external cache separation (?feeds=na vs ?feeds=na,row)",
            False,
            f"unexpected feed sets: na_keys={na_keys} nr_keys={nr_keys}",
        )


def test_voice_transcribe_empty(token):
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.post(
            f"{API}/voice/transcribe",
            headers=headers,
            json={"audio_b64": "", "mime": "audio/m4a"},
            timeout=15,
        )
    except Exception as e:
        record("voice/transcribe empty audio → 400", False, f"request error: {e}")
        return
    if r.status_code == 400:
        record(
            "voice/transcribe empty audio → 400",
            True,
            f"status=400 detail={r.text[:120]}",
        )
    else:
        record(
            "voice/transcribe empty audio → 400",
            False,
            f"expected 400, got {r.status_code} body={r.text[:200]}",
        )


def main():
    print("=" * 70)
    print("Rev Radar / Convoy backend tests (multi-feed)")
    print("=" * 70)

    test_feed_unauth()
    token = test_login_sanity()
    if not token:
        print("[FATAL] Could not login as demo user; aborting authed tests.")
    else:
        # Order matters: cache is per-set, so issue ?feeds=na first, then
        # ?feeds=row, then ?feeds=na,row. Then re-hit ?feeds=na,row to test
        # cache identity.
        na_data = test_feed_na_only(token)
        row_data = test_feed_row_only(token)
        na_row_first = test_feed_na_row(token)
        time.sleep(1.0)
        test_feed_cache_same_set(token, na_row_first)
        test_feed_cache_different_keys(token, na_data, na_row_first)
        test_feed_invalid(token)
        test_feed_no_param(token)
        test_voice_transcribe_empty(token)

    print("=" * 70)
    passed = sum(1 for r in results if r["ok"])
    failed = sum(1 for r in results if not r["ok"])
    print(f"SUMMARY: {passed} passed, {failed} failed (total {len(results)})")
    for r in results:
        flag = "PASS" if r["ok"] else "FAIL"
        print(f"  [{flag}] {r['name']}")
    print("=" * 70)
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
