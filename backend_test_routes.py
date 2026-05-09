"""Backend tests for Community Routes endpoints.

Tests:
- POST /api/communities/{cid}/routes (admin-only insert)
- GET /api/communities/{cid}/routes (members-only list)
- DELETE /api/communities/{cid}/routes/{rid} (admin-only soft-delete)
- POST /api/communities (creates community + Supabase mirror)
"""
import sys
import uuid
import time
import secrets
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"
TIMEOUT = 15

results = []
def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}")
    results.append((name, ok, detail))


def login(email=EMAIL, password=PASSWORD):
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": password}, timeout=TIMEOUT)
    if r.status_code != 200:
        return None
    data = r.json()
    return data.get("token") or data.get("access_token")


def register(email, password, handle):
    r = requests.post(f"{BASE}/auth/register", json={
        "email": email, "password": password, "handle": handle,
        "car_make": "Mazda", "car_model": "Miata", "car_year": 1995, "car_color": "Green",
    }, timeout=TIMEOUT)
    if r.status_code != 200:
        return None
    return r.json().get("token")


def main():
    cid = None
    rid = None
    bogus_uuid = "00000000-0000-0000-0000-000000000000"

    # =========================================================
    # A. Auth gate
    # =========================================================
    any_uuid = str(uuid.uuid4())
    r = requests.post(f"{BASE}/communities/{any_uuid}/routes", json={
        "community_id": any_uuid, "name": "x", "dest_lat": 0, "dest_lng": 0,
    }, timeout=TIMEOUT)
    record("A1. POST routes without bearer -> 401",
           r.status_code == 401,
           f"status={r.status_code} body={r.text[:200]}")

    r = requests.get(f"{BASE}/communities/{any_uuid}/routes", timeout=TIMEOUT)
    record("A2. GET routes without bearer -> 401",
           r.status_code == 401,
           f"status={r.status_code} body={r.text[:200]}")

    r = requests.delete(f"{BASE}/communities/{any_uuid}/routes/{any_uuid}", timeout=TIMEOUT)
    record("A3. DELETE route without bearer -> 401",
           r.status_code == 401,
           f"status={r.status_code} body={r.text[:200]}")

    # =========================================================
    # B. Setup — login demo, create community
    # =========================================================
    token = login()
    if not token:
        record("B0. Demo login", False, "Could not login as demo")
        print_summary(); return
    record("B0. Demo login", True, "JWT obtained")
    H = {"Authorization": f"Bearer {token}"}

    cbody = {"name": "E2E Routes Test", "description": "backend test", "is_public": True}
    r = requests.post(f"{BASE}/communities", json=cbody, headers=H, timeout=TIMEOUT)
    ok = r.status_code == 200 and isinstance(r.json(), dict) and r.json().get("id")
    if ok:
        cid = r.json()["id"]
    record("B1. POST /api/communities -> 200 + id (auto-admin)",
           bool(ok),
           f"status={r.status_code} cid={cid} is_admin={r.json().get('is_admin') if ok else None}")
    if not cid:
        print_summary(); return

    # =========================================================
    # C. Happy path — POST /communities/{cid}/routes
    # =========================================================
    rbody = {
        "community_id": cid,
        "name": "Sunday cruise to Half Moon Bay",
        "description": "Coastal run",
        "dest_label": "Half Moon Bay, CA",
        "dest_lat": 37.4636,
        "dest_lng": -122.4286,
        "polyline": "abc_test_polyline",
    }
    r = requests.post(f"{BASE}/communities/{cid}/routes", json=rbody, headers=H, timeout=TIMEOUT)
    ok = (r.status_code == 200) and isinstance(r.json(), dict)
    body = r.json() if ok else {}
    if ok:
        rid = body.get("id")
    happy_ok = (
        ok and rid is not None
        and body.get("community_id") == cid
        and body.get("is_active") is True
        and abs(float(body.get("dest_lat") or 0) - 37.4636) < 1e-6
        and abs(float(body.get("dest_lng") or 0) - (-122.4286)) < 1e-6
        and body.get("created_at")
    )
    record("C1. POST route happy path -> 200 + Supabase row",
           happy_ok,
           f"status={r.status_code} rid={rid} is_active={body.get('is_active')} "
           f"community_id_match={body.get('community_id') == cid} "
           f"dest=({body.get('dest_lat')},{body.get('dest_lng')}) created_at={body.get('created_at')}")
    if not rid:
        cleanup(cid, H); print_summary(); return

    # =========================================================
    # D. Body / path mismatch
    # =========================================================
    mis_body = dict(rbody)
    mis_body["community_id"] = str(uuid.uuid4())  # different uuid
    r = requests.post(f"{BASE}/communities/{cid}/routes", json=mis_body, headers=H, timeout=TIMEOUT)
    detail = ""
    try: detail = r.json().get("detail", "")
    except Exception: pass
    record("D1. body/path community_id mismatch -> 400",
           r.status_code == 400 and detail == "Path/body community_id mismatch",
           f"status={r.status_code} detail={detail!r}")

    # =========================================================
    # E. List
    # =========================================================
    r = requests.get(f"{BASE}/communities/{cid}/routes", headers=H, timeout=TIMEOUT)
    rows = r.json() if r.status_code == 200 else []
    found = any((row.get("id") == rid and row.get("is_active") is True) for row in rows) if isinstance(rows, list) else False
    record("E1. GET routes -> 200 list contains rid (is_active=true)",
           r.status_code == 200 and found,
           f"status={r.status_code} count={len(rows) if isinstance(rows, list) else 'NA'} contains_rid={found}")

    # =========================================================
    # F. Soft-delete
    # =========================================================
    r = requests.delete(f"{BASE}/communities/{cid}/routes/{rid}", headers=H, timeout=TIMEOUT)
    body = {}
    try: body = r.json()
    except Exception: pass
    record("F1. DELETE route -> 200 {ok:true}",
           r.status_code == 200 and body.get("ok") is True,
           f"status={r.status_code} body={body}")

    # GET should not include rid anymore
    r = requests.get(f"{BASE}/communities/{cid}/routes", headers=H, timeout=TIMEOUT)
    rows = r.json() if r.status_code == 200 else []
    still_found = any(row.get("id") == rid for row in rows) if isinstance(rows, list) else True
    record("F2. GET routes after delete -> rid NOT in list",
           r.status_code == 200 and not still_found,
           f"status={r.status_code} count={len(rows) if isinstance(rows, list) else 'NA'} contains_rid={still_found}")

    # =========================================================
    # G. 404 paths
    # =========================================================
    g_body = dict(rbody)
    g_body["community_id"] = bogus_uuid
    r = requests.post(f"{BASE}/communities/{bogus_uuid}/routes", json=g_body, headers=H, timeout=TIMEOUT)
    detail = ""
    try: detail = r.json().get("detail", "")
    except Exception: pass
    record("G1. POST route to non-existent cid -> 404 'Community not found'",
           r.status_code == 404 and detail == "Community not found",
           f"status={r.status_code} detail={detail!r}")

    r = requests.get(f"{BASE}/communities/{bogus_uuid}/routes", headers=H, timeout=TIMEOUT)
    detail = ""
    try: detail = r.json().get("detail", "")
    except Exception: pass
    record("G2. GET routes for non-existent cid -> 404 'Community not found'",
           r.status_code == 404 and detail == "Community not found",
           f"status={r.status_code} detail={detail!r}")

    # =========================================================
    # H. Non-admin path — register a 2nd user, attempt to access cid
    # =========================================================
    rand = secrets.token_hex(6)
    email2 = f"e2e_{rand}@revradar.app"
    pwd2 = f"Pass_{rand}!"
    handle2 = f"E2EDriver_{rand[:4]}"
    token2 = register(email2, pwd2, handle2)
    if not token2:
        record("H0. Register 2nd user", False, f"failed for {email2}")
    else:
        record("H0. Register 2nd user", True, f"email={email2}")
        H2 = {"Authorization": f"Bearer {token2}"}

        # GET as non-member -> 403
        r = requests.get(f"{BASE}/communities/{cid}/routes", headers=H2, timeout=TIMEOUT)
        detail = ""
        try: detail = r.json().get("detail", "")
        except Exception: pass
        record("H1. GET routes as non-member -> 403 'Not a member of this community'",
               r.status_code == 403 and detail == "Not a member of this community",
               f"status={r.status_code} detail={detail!r}")

        # POST as non-admin -> 403
        post_body = dict(rbody); post_body["community_id"] = cid
        r = requests.post(f"{BASE}/communities/{cid}/routes", json=post_body, headers=H2, timeout=TIMEOUT)
        detail = ""
        try: detail = r.json().get("detail", "")
        except Exception: pass
        record("H2. POST route as non-admin -> 403 'Only the community admin can manage routes'",
               r.status_code == 403 and detail == "Only the community admin can manage routes",
               f"status={r.status_code} detail={detail!r}")

    # Cleanup
    cleanup(cid, H)

    print_summary()


def cleanup(cid, H):
    try:
        r = requests.delete(f"{BASE}/communities/{cid}", headers=H, timeout=TIMEOUT)
        print(f"[cleanup] DELETE community {cid} -> {r.status_code}")
    except Exception as e:
        print(f"[cleanup] failed: {e}")


def print_summary():
    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"{passed}/{total} passed")
    fails = [(n, d) for n, ok, d in results if not ok]
    if fails:
        print("FAILURES:")
        for n, d in fails:
            print(f"  - {n} :: {d}")
        sys.exit(1)


if __name__ == "__main__":
    main()
