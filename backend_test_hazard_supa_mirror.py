"""
Backend test: POST /api/hazards mirrors to Supabase (no regression).

Verifies the recently-added asyncio.create_task(supa.upsert_row("hazards", ...))
does NOT block the HTTP response and that all hazard-related endpoints
(create/list/delete/confirm/dispute, kinds, auth gating, invalid kind) still
work as designed against the public URL.
"""
import os
import time
import json
import sys
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"

results = []  # list[(name, ok, detail)]

def record(name, ok, detail=""):
    results.append((name, ok, detail))
    sym = "PASS" if ok else "FAIL"
    print(f"[{sym}] {name} - {detail}")


def main():
    s = requests.Session()
    # 1. Login
    t0 = time.time()
    r = s.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    record("1. Login 200 + JWT", r.status_code == 200 and bool(r.json().get("token")),
           f"http={r.status_code} body_keys={list(r.json().keys()) if r.headers.get('content-type','').startswith('application/json') else r.text[:120]}")
    if r.status_code != 200:
        return summary()
    token = r.json()["token"]
    auth = {"Authorization": f"Bearer {token}"}

    # 2. Create police hazard + measure response time
    body = {"kind": "police", "lat": 37.5, "lng": -122.3, "note": ""}
    t_start = time.time()
    r = s.post(f"{BASE}/hazards", json=body, headers=auth, timeout=15)
    elapsed = time.time() - t_start
    ok = r.status_code == 200
    h = r.json() if ok else {}
    full_ok = (
        ok and
        isinstance(h.get("id"), str) and len(h.get("id", "")) >= 32 and
        h.get("kind") == "police" and
        h.get("confirms") == 1 and
        isinstance(h.get("expires_at"), str) and
        isinstance(h.get("reporter_id"), str) and
        isinstance(h.get("reporter_handle"), str) and h.get("reporter_handle") != ""
    )
    record("2. POST /hazards (police) returns full doc",
           full_ok,
           f"http={r.status_code} id={h.get('id')!r} kind={h.get('kind')!r} confirms={h.get('confirms')!r} reporter_handle={h.get('reporter_handle')!r}")
    if not full_ok:
        return summary()
    police_id = h["id"]

    # 3. Response time fast (<2s; <3s = pass)
    record("3. POST /hazards response time < 2s (Supabase upsert non-blocking)",
           elapsed < 2.0,
           f"elapsed={elapsed:.3f}s")
    # also flag regression if >3s
    if elapsed >= 3.0:
        record("3b. Response time < 3s (HARD regression cap)", False, f"elapsed={elapsed:.3f}s")
    else:
        record("3b. Response time < 3s (HARD regression cap)", True, f"elapsed={elapsed:.3f}s")

    # 4. GET /api/hazards lists the new hazard
    r = s.get(f"{BASE}/hazards", headers=auth, timeout=15)
    listed = r.json() if r.status_code == 200 else []
    ids = [x.get("id") for x in listed]
    record("4. GET /hazards contains the new id",
           r.status_code == 200 and police_id in ids,
           f"http={r.status_code} count={len(ids)} contains={police_id in ids}")

    # 5. Create road hazard
    r = s.post(f"{BASE}/hazards", json={"kind": "road", "lat": 37.5, "lng": -122.3}, headers=auth, timeout=15)
    h_road = r.json() if r.status_code == 200 else {}
    road_id = h_road.get("id")
    record("5. POST /hazards (road) returns full doc",
           r.status_code == 200 and h_road.get("kind") == "road" and bool(road_id),
           f"http={r.status_code} id={road_id} kind={h_road.get('kind')!r}")

    # 6. Create accident hazard
    r = s.post(f"{BASE}/hazards", json={"kind": "accident", "lat": 37.5, "lng": -122.3}, headers=auth, timeout=15)
    h_acc = r.json() if r.status_code == 200 else {}
    accident_id = h_acc.get("id")
    record("6. POST /hazards (accident) returns 200",
           r.status_code == 200 and h_acc.get("kind") == "accident" and bool(accident_id),
           f"http={r.status_code} id={accident_id} kind={h_acc.get('kind')!r}")

    # 7. Invalid kind rejected
    r = s.post(f"{BASE}/hazards", json={"kind": "banana", "lat": 37.5, "lng": -122.3}, headers=auth, timeout=15)
    detail = ""
    try:
        detail = r.json().get("detail", "")
    except Exception:
        pass
    record("7. POST /hazards kind='banana' → 400 'Invalid hazard kind'",
           r.status_code == 400 and "Invalid hazard kind" in detail,
           f"http={r.status_code} detail={detail!r}")

    # 8. Auth gate — no Authorization header → 401
    r = requests.post(f"{BASE}/hazards", json={"kind": "police", "lat": 37.5, "lng": -122.3}, timeout=15)
    record("8. POST /hazards without auth → 401",
           r.status_code == 401,
           f"http={r.status_code}")

    # 9. DELETE still works (idempotent)
    r = s.delete(f"{BASE}/hazards/{police_id}", headers=auth, timeout=15)
    j = r.json() if r.status_code == 200 else {}
    record("9. DELETE /hazards/{id} → 200 {ok:true,id}",
           r.status_code == 200 and j.get("ok") is True and j.get("id") == police_id,
           f"http={r.status_code} body={j}")

    # 10. Dispute still works on a fresh hazard
    r = s.post(f"{BASE}/hazards", json={"kind": "police", "lat": 37.6, "lng": -122.4}, headers=auth, timeout=15)
    if r.status_code != 200:
        record("10a. setup hazard for dispute", False, f"http={r.status_code}")
    else:
        dispute_id = r.json()["id"]
        rd = s.post(f"{BASE}/hazards/{dispute_id}/dispute", headers=auth, timeout=15)
        jd = rd.json() if rd.status_code == 200 else {}
        record("10. POST /hazards/{id}/dispute → 200 disputes=1",
               rd.status_code == 200 and jd.get("disputes") == 1,
               f"http={rd.status_code} disputes={jd.get('disputes')!r}")

    # 11. Confirm still works on a fresh hazard
    r = s.post(f"{BASE}/hazards", json={"kind": "accident", "lat": 37.7, "lng": -122.5}, headers=auth, timeout=15)
    if r.status_code != 200:
        record("11a. setup hazard for confirm", False, f"http={r.status_code}")
    else:
        confirm_id = r.json()["id"]
        rc = s.post(f"{BASE}/hazards/{confirm_id}/confirm", headers=auth, timeout=15)
        jc = rc.json() if rc.status_code == 200 else {}
        record("11. POST /hazards/{id}/confirm → 200 confirms=2",
               rc.status_code == 200 and jc.get("confirms") == 2,
               f"http={rc.status_code} confirms={jc.get('confirms')!r}")

    # Cleanup created hazards
    for hid in [road_id, accident_id]:
        if hid:
            try:
                s.delete(f"{BASE}/hazards/{hid}", headers=auth, timeout=10)
            except Exception:
                pass

    return summary()


def summary():
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"RESULTS: {passed}/{len(results)} PASS")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL → {name}  | {detail}")
    return passed, len(results)


if __name__ == "__main__":
    p, t = main()
    sys.exit(0 if p == t else 1)
