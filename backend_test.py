"""Backend tests for Rev Radar / Convoy API.

Focus: GET /api/feed/external + sanity checks for /api/auth/login and
/api/voice/transcribe. Uses public REACT/EXPO backend URL from
frontend/.env (EXPO_PUBLIC_BACKEND_URL) — never localhost.
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
        r = requests.post(f"{API}/auth/login",
                          json={"email": DEMO_EMAIL, "password": DEMO_PASS},
                          timeout=15)
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
    record("auth/login sanity", True,
           f"got token len={len(token)} user.email={user.get('email')}")
    return token


def test_feed_unauth():
    try:
        r = requests.get(f"{API}/feed/external", timeout=15)
    except Exception as e:
        record("feed/external auth gate (no token → 401)", False, f"request error: {e}")
        return
    if r.status_code == 401:
        record("feed/external auth gate (no token → 401)", True,
               f"status=401 detail={r.text[:120]}")
    else:
        record("feed/external auth gate (no token → 401)", False,
               f"expected 401, got {r.status_code} body={r.text[:200]}")


REQUIRED_KEYS = {"alerts", "count", "fetched_at", "source",
                 "upstream_status", "upstream_error"}
ALLOWED_UPSTREAM_STATUSES = {"ok", "http_error", "network_error", "parse_error"}


def _validate_shape(data, label):
    missing = REQUIRED_KEYS - set(data.keys())
    if missing:
        record(f"feed/external shape ({label})", False,
               f"missing keys: {missing}; got keys={list(data.keys())}")
        return False
    if not isinstance(data["alerts"], list):
        record(f"feed/external shape ({label})", False,
               f"'alerts' is not a list: {type(data['alerts'])}")
        return False
    if not isinstance(data["count"], int):
        record(f"feed/external shape ({label})", False,
               f"'count' is not int: {type(data['count'])}")
        return False
    if data["count"] != len(data["alerts"]):
        record(f"feed/external shape ({label})", False,
               f"count={data['count']} != len(alerts)={len(data['alerts'])}")
        return False
    if data["upstream_status"] not in ALLOWED_UPSTREAM_STATUSES:
        record(f"feed/external shape ({label})", False,
               f"upstream_status invalid: {data['upstream_status']}")
        return False
    # fetched_at iso8601 sanity
    fa = data.get("fetched_at")
    if not isinstance(fa, str) or "T" not in fa:
        record(f"feed/external shape ({label})", False,
               f"fetched_at not iso8601-ish: {fa}")
        return False
    record(f"feed/external shape ({label})", True,
           f"count={data['count']} upstream_status={data['upstream_status']} "
           f"upstream_error={data['upstream_error']!r} source={data['source']!r}")
    return True


def test_feed_authed(token):
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.get(f"{API}/feed/external", headers=headers, timeout=20)
    except Exception as e:
        record("feed/external authed (200 + shape)", False, f"request error: {e}")
        return None
    if r.status_code != 200:
        record("feed/external authed (200 + shape)", False,
               f"expected 200, got {r.status_code} body={r.text[:300]}")
        return None
    try:
        data = r.json()
    except Exception as e:
        record("feed/external authed (200 + shape)", False, f"non-json: {e}")
        return None
    record("feed/external authed (200 + shape)", True,
           f"status=200 alerts_len={len(data.get('alerts', []))}")
    _validate_shape(data, "authed")
    return data


def test_feed_cache(token, prev):
    if prev is None:
        record("feed/external cache (same fetched_at within TTL)", False,
               "no previous response to compare")
        return
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.get(f"{API}/feed/external", headers=headers, timeout=20)
    except Exception as e:
        record("feed/external cache (same fetched_at within TTL)", False,
               f"request error: {e}")
        return
    if r.status_code != 200:
        record("feed/external cache (same fetched_at within TTL)", False,
               f"expected 200 got {r.status_code}")
        return
    data = r.json()
    if data.get("fetched_at") == prev.get("fetched_at"):
        record("feed/external cache (same fetched_at within TTL)", True,
               f"fetched_at matched: {data['fetched_at']}")
    else:
        record("feed/external cache (same fetched_at within TTL)", False,
               f"fetched_at differs: prev={prev.get('fetched_at')} now={data.get('fetched_at')}")


def test_feed_bbox(token):
    headers = {"Authorization": f"Bearer {token}"}
    params = {"top": 37.8, "bottom": 37.7, "left": -122.5, "right": -122.4}
    try:
        r = requests.get(f"{API}/feed/external", headers=headers,
                         params=params, timeout=20)
    except Exception as e:
        record("feed/external bbox params (200 + shape)", False, f"request error: {e}")
        return
    if r.status_code != 200:
        record("feed/external bbox params (200 + shape)", False,
               f"expected 200 got {r.status_code} body={r.text[:300]}")
        return
    data = r.json()
    record("feed/external bbox params (200 + shape)", True,
           f"status=200 count={data.get('count')} upstream_status={data.get('upstream_status')}")
    _validate_shape(data, "bbox")


def test_voice_transcribe_empty(token):
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.post(f"{API}/voice/transcribe", headers=headers,
                          json={"audio_b64": "", "mime": "audio/m4a"}, timeout=15)
    except Exception as e:
        record("voice/transcribe empty audio → 400", False, f"request error: {e}")
        return
    if r.status_code == 400:
        record("voice/transcribe empty audio → 400", True,
               f"status=400 detail={r.text[:120]}")
    else:
        record("voice/transcribe empty audio → 400", False,
               f"expected 400, got {r.status_code} body={r.text[:200]}")


def main():
    print("=" * 70)
    print("Rev Radar / Convoy backend tests")
    print("=" * 70)

    test_feed_unauth()
    token = test_login_sanity()
    if not token:
        print("[FATAL] Could not login as demo user; aborting authed tests.")
    else:
        # Important: cache is process-wide so first authed call seeds it.
        first = test_feed_authed(token)
        # Within 5s -> should hit cache
        time.sleep(1.0)
        test_feed_cache(token, first)
        test_feed_bbox(token)
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
