"""Backend tests for Convoy hazard dispute endpoint.

Focused on POST /api/hazards/{hid}/dispute community-moderation logic.
"""
import sys
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"

results = []
def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}")
    results.append((name, ok, detail))

def login():
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    tok = data.get("token") or data.get("access_token")
    assert tok, f"no token in login response: {data}"
    return tok

def main():
    # 1. Auth gate
    r = requests.post(f"{BASE}/hazards/00000000-0000-0000-0000-000000000000/dispute", timeout=15)
    record(
        "1. Auth gate (no bearer) -> 401",
        r.status_code == 401 and r.json().get("detail") == "Not authenticated",
        f"status={r.status_code} body={r.text[:200]}",
    )

    token = login()
    H = {"Authorization": f"Bearer {token}"}

    # 2. Create hazard
    body = {"kind": "police", "lat": 37.7749, "lng": -122.4194, "note": ""}
    r = requests.post(f"{BASE}/hazards", json=body, headers=H, timeout=15)
    ok = r.status_code in (200, 201) and isinstance(r.json(), dict) and r.json().get("id")
    hazard = r.json() if ok else {}
    hid = hazard.get("id")
    record(
        "2. Create hazard -> 200/201 with id",
        bool(ok),
        f"status={r.status_code} id={hid} kind={hazard.get('kind')} confirms={hazard.get('confirms')}",
    )
    if not hid:
        print("Cannot continue without hazard id"); return

    record(
        "2b. Created hazard has confirms=1 and no disputes",
        hazard.get("confirms") == 1 and hazard.get("disputes", 0) == 0,
        f"confirms={hazard.get('confirms')} disputes={hazard.get('disputes', 0)}",
    )

    # 3. First dispute -> disputes:1
    r = requests.post(f"{BASE}/hazards/{hid}/dispute", headers=H, timeout=15)
    j = r.json()
    record(
        "3. First dispute -> 200, disputes==1",
        r.status_code == 200 and j.get("disputes") == 1,
        f"status={r.status_code} disputes={j.get('disputes')} confirms={j.get('confirms')} expires_at={j.get('expires_at')}",
    )

    r_list = requests.get(f"{BASE}/hazards", headers=H, timeout=15)
    listed_ids = [h.get("id") for h in r_list.json()] if r_list.status_code == 200 else []
    record(
        "3b. After 1st dispute, hazard still in GET /api/hazards",
        hid in listed_ids,
        f"status={r_list.status_code} count={len(listed_ids)} present={hid in listed_ids}",
    )

    # 4a. Second dispute
    r = requests.post(f"{BASE}/hazards/{hid}/dispute", headers=H, timeout=15)
    j2 = r.json()
    record(
        "4a. Second dispute -> 200, disputes==2",
        r.status_code == 200 and j2.get("disputes") == 2,
        f"status={r.status_code} disputes={j2.get('disputes')} confirms={j2.get('confirms')}",
    )

    r_list = requests.get(f"{BASE}/hazards", headers=H, timeout=15)
    listed_ids = [h.get("id") for h in r_list.json()] if r_list.status_code == 200 else []
    record(
        "4b. After 2nd dispute, hazard still in GET /api/hazards (under threshold)",
        hid in listed_ids,
        f"present={hid in listed_ids} (disputes=2, threshold confirms+2=3)",
    )

    # 4c. Third dispute - hits threshold
    r = requests.post(f"{BASE}/hazards/{hid}/dispute", headers=H, timeout=15)
    j3 = r.json()
    record(
        "4c. Third dispute -> 200, disputes==3",
        r.status_code == 200 and j3.get("disputes") == 3,
        f"status={r.status_code} disputes={j3.get('disputes')} confirms={j3.get('confirms')} expires_at={j3.get('expires_at')}",
    )

    # 4d. Hazard should be expired and not appear in list
    r_list = requests.get(f"{BASE}/hazards", headers=H, timeout=15)
    listed_ids = [h.get("id") for h in r_list.json()] if r_list.status_code == 200 else []
    record(
        "4d. After 3rd dispute (disputes>=confirms+2), hazard EXPIRED -- gone from GET /api/hazards",
        r_list.status_code == 200 and hid not in listed_ids,
        f"status={r_list.status_code} hazard_present={hid in listed_ids} (expected False)",
    )

    # 5. 404 on nonexistent
    bogus = "00000000-0000-0000-0000-000000000000"
    r = requests.post(f"{BASE}/hazards/{bogus}/dispute", headers=H, timeout=15)
    record(
        "5. Dispute non-existent hazard -> 404 'Not found'",
        r.status_code == 404 and r.json().get("detail") == "Not found",
        f"status={r.status_code} body={r.text[:200]}",
    )

    # 6. Confirm endpoint regression
    body2 = {"kind": "accident", "lat": 40.7128, "lng": -74.0060, "note": "test confirm regression"}
    r = requests.post(f"{BASE}/hazards", json=body2, headers=H, timeout=15)
    h2 = r.json() if r.status_code in (200, 201) else {}
    hid2 = h2.get("id")
    record(
        "6a. Create fresh hazard for confirm regression",
        bool(hid2),
        f"status={r.status_code} id={hid2} confirms={h2.get('confirms')}",
    )
    if hid2:
        rc = requests.post(f"{BASE}/hazards/{hid2}/confirm", headers=H, timeout=15)
        cj = rc.json()
        record(
            "6b. Confirm endpoint -> 200, confirms==2",
            rc.status_code == 200 and cj.get("confirms") == 2,
            f"status={rc.status_code} confirms={cj.get('confirms')}",
        )

    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"{passed}/{total} passed")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name} :: {detail}")
    sys.exit(0 if passed == total else 1)

if __name__ == "__main__":
    main()
