"""
Verify Waze external feed removal cleanup verification.

Tests:
(1) GET /api/feed/external (and ?feeds=na, ?feeds=na,row) → 404
(2) Regression: auth/me, communities/mine, hazards CRUD, directions, tts
(3) Backend log scan: zero new Traceback / Internal Server Error / ImportError / NameError
(4) Waze rtproxy polling log spam: zero new rtproxy-na/row.waze.com entries after 90s
"""
import os
import sys
import time
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
ERR_LOG = "/var/log/supervisor/backend.err.log"
OUT_LOG = "/var/log/supervisor/backend.out.log"


def _offset(path: str) -> int:
    try:
        return os.path.getsize(path)
    except FileNotFoundError:
        return 0


def _read_after(path: str, offset: int) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read().decode("utf-8", errors="replace")
    except FileNotFoundError:
        return ""


results = []


def record(name: str, ok: bool, detail: str = ""):
    results.append((name, ok, detail))
    sym = "PASS" if ok else "FAIL"
    print(f"[{sym}] {name} :: {detail}")


def main():
    # Capture initial offsets
    err_offset_initial = _offset(ERR_LOG)
    out_offset_initial = _offset(OUT_LOG)
    print(f"Initial backend.err.log offset: {err_offset_initial}")
    print(f"Initial backend.out.log offset: {out_offset_initial}")

    # 0. Login
    r = requests.post(f"{BASE}/auth/login", json={"email": "demo@revradar.app", "password": "demo1234"}, timeout=30)
    if r.status_code != 200:
        record("login_demo", False, f"HTTP {r.status_code} body={r.text[:200]}")
        return
    j = r.json()
    token = j.get("token") or j.get("access_token")
    if not token:
        record("login_demo", False, f"no token in response: keys={list(j.keys())}")
        return
    record("login_demo", True, f"token len={len(token)}")
    H = {"Authorization": f"Bearer {token}"}

    # 1. NEW BEHAVIOR — /api/feed/external must be 404
    for q in ["", "?feeds=na", "?feeds=na,row"]:
        r = requests.get(f"{BASE}/feed/external{q}", headers=H, timeout=15)
        ok = r.status_code == 404
        record(f"feed_external_404{q or '_no_params'}", ok, f"HTTP {r.status_code}")

    # 2. REGRESSION
    # /auth/me
    r = requests.get(f"{BASE}/auth/me", headers=H, timeout=15)
    record("auth_me_200", r.status_code == 200, f"HTTP {r.status_code}")

    # /communities/mine
    r = requests.get(f"{BASE}/communities/mine", headers=H, timeout=15)
    record("communities_mine_200", r.status_code == 200, f"HTTP {r.status_code}")

    # /hazards list
    r = requests.get(f"{BASE}/hazards", headers=H, timeout=15)
    record("hazards_list_200", r.status_code == 200, f"HTTP {r.status_code}")

    # POST /hazards
    r = requests.post(
        f"{BASE}/hazards",
        headers=H,
        json={"kind": "police", "lat": 37.5, "lng": -122.3, "note": ""},
        timeout=15,
    )
    hid = None
    if r.status_code == 200:
        hid = r.json().get("id")
        record("hazards_post_200", bool(hid), f"HTTP 200 id={hid}")
    else:
        record("hazards_post_200", False, f"HTTP {r.status_code} body={r.text[:200]}")

    # DELETE /hazards/{id}
    if hid:
        r = requests.delete(f"{BASE}/hazards/{hid}", headers=H, timeout=15)
        body_ok = False
        try:
            jb = r.json()
            body_ok = jb.get("ok") is True and jb.get("id") == hid
        except Exception:
            pass
        record("hazards_delete_200", r.status_code == 200 and body_ok, f"HTTP {r.status_code} body={r.text[:200]}")

    # /directions
    r = requests.get(
        f"{BASE}/directions",
        params={
            "origin_lat": 37.5,
            "origin_lng": -122.3,
            "dest_lat": 37.6,
            "dest_lng": -122.4,
        },
        headers=H,
        timeout=30,
    )
    ok = r.status_code in (200, 503)
    record("directions_200_or_503", ok, f"HTTP {r.status_code} (200 if GOOGLE_MAPS_KEY set, 503 if not)")

    # /tts → expect 503 (quota exhausted) - both 503 and other graceful failures acceptable, just not 5xx Traceback
    r = requests.post(f"{BASE}/tts", headers=H, json={"text": "test"}, timeout=15)
    # spec says 503 expected, accept 503 only
    record("tts_503", r.status_code == 503, f"HTTP {r.status_code} body={r.text[:200]}")

    # 3. LOG SCAN
    err_new = _read_after(ERR_LOG, err_offset_initial)
    bad_markers = ["Traceback (most recent call last)", "Internal Server Error", "ImportError", "NameError"]
    bad_found = {m: err_new.count(m) for m in bad_markers}
    total_bad = sum(bad_found.values())
    record(
        "backend_err_log_clean",
        total_bad == 0,
        f"new_bytes={len(err_new)} markers={bad_found}",
    )

    # 4. WAZE POLLING SPAM CHECK
    print("\nWaiting 90s to check for Waze polling log spam...")
    err_offset_pre_wait = _offset(ERR_LOG)
    out_offset_pre_wait = _offset(OUT_LOG)
    time.sleep(90)
    err_new2 = _read_after(ERR_LOG, err_offset_pre_wait)
    out_new2 = _read_after(OUT_LOG, out_offset_pre_wait)
    combined = err_new2 + out_new2
    rtproxy_na = combined.count("rtproxy-na.waze.com")
    rtproxy_row = combined.count("rtproxy-row.waze.com")
    record(
        "no_waze_polling_spam",
        rtproxy_na == 0 and rtproxy_row == 0,
        f"rtproxy-na={rtproxy_na} rtproxy-row={rtproxy_row} new_err_bytes={len(err_new2)} new_out_bytes={len(out_new2)}",
    )

    # Summary
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"TOTAL: {passed}/{total} passed")
    for name, ok, detail in results:
        sym = "PASS" if ok else "FAIL"
        print(f"  [{sym}] {name}: {detail}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
