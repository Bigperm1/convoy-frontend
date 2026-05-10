"""
Backend tests for DELETE /api/hazards/{hid} endpoint per current_focus in test_result.md.

Tests:
1. Auth gate: DELETE without Authorization → 401
2. Create hazard via POST /api/hazards → capture id
3. DELETE /api/hazards/{id} with bearer → 200 {ok:true, id:<same>}
4. GET /api/hazards confirms list does NOT contain deleted id
5. Idempotency: DELETE same id again → 200 (NOT 404)
6. Bonus regression: POST /api/hazards/{other_id}/dispute still works
"""
import os
import sys
import json
import requests

BASE = os.environ.get("BACKEND_URL", "https://motorist-hub.preview.emergentagent.com").rstrip("/") + "/api"
DEMO_EMAIL = "demo@revradar.app"
DEMO_PASS = "demo1234"

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}{(' — ' + detail) if detail else ''}")
    return ok

print(f"BASE = {BASE}")

# --- 1. Auth gate ---
r = requests.delete(f"{BASE}/hazards/anything-no-auth-test", timeout=15)
check("1. DELETE /api/hazards/<id> without bearer → 401",
      r.status_code == 401,
      f"got HTTP {r.status_code} body={r.text[:200]}")

# --- Login as demo ---
r = requests.post(f"{BASE}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASS}, timeout=15)
if r.status_code != 200:
    print(f"FATAL: login failed HTTP {r.status_code} body={r.text[:300]}")
    sys.exit(2)
token = r.json().get("token") or r.json().get("access_token")
if not token:
    print(f"FATAL: no token in login response: {r.json()}")
    sys.exit(2)
H = {"Authorization": f"Bearer {token}"}
print(f"Login OK; token len={len(token)}")

# --- 2. Create hazard ---
r = requests.post(f"{BASE}/hazards", headers=H,
                  json={"kind": "police", "lat": 37.5, "lng": -122.3}, timeout=15)
ok2 = r.status_code == 200 and isinstance(r.json(), dict) and r.json().get("id")
hid = r.json().get("id") if r.status_code == 200 else None
check("2. POST /api/hazards (police, 37.5,-122.3) → 200 with id",
      ok2,
      f"HTTP {r.status_code} id={hid} kind={r.json().get('kind') if r.status_code==200 else None}")

# --- 3. DELETE captured id ---
r = requests.delete(f"{BASE}/hazards/{hid}", headers=H, timeout=15)
body = {}
try: body = r.json()
except Exception: pass
ok3 = (r.status_code == 200 and body.get("ok") is True and body.get("id") == hid)
check("3. DELETE /api/hazards/{id} → 200 {ok:true, id:<same>}",
      ok3,
      f"HTTP {r.status_code} body={body}")

# --- 4. Confirm gone via GET /api/hazards?lat=37.5&lng=-122.3&radius_km=1 ---
# (Note: list_hazards in server.py doesn't actually use lat/lng/radius params,
#  it lists all unexpired hazards. We pass them per spec but verify the deleted id is absent.)
r = requests.get(f"{BASE}/hazards", params={"lat": 37.5, "lng": -122.3, "radius_km": 1},
                 headers=H, timeout=15)
listed = r.json() if r.status_code == 200 else []
ids_in_list = [h.get("id") for h in listed] if isinstance(listed, list) else []
ok4 = (r.status_code == 200 and isinstance(listed, list) and hid not in ids_in_list)
check("4. GET /api/hazards does NOT contain deleted id",
      ok4,
      f"HTTP {r.status_code} count={len(ids_in_list)} contains_deleted={hid in ids_in_list}")

# --- 5. Idempotency: delete again ---
r = requests.delete(f"{BASE}/hazards/{hid}", headers=H, timeout=15)
body5 = {}
try: body5 = r.json()
except Exception: pass
ok5 = (r.status_code == 200 and body5.get("ok") is True)
check("5. DELETE same id again (idempotency) → 200 (NOT 404)",
      ok5,
      f"HTTP {r.status_code} body={body5}")

# --- 6. Bonus regression: dispute endpoint preserved ---
# Create a fresh hazard for the dispute test (so we don't conflict with anything).
r = requests.post(f"{BASE}/hazards", headers=H,
                  json={"kind": "accident", "lat": 40.7128, "lng": -74.0060,
                        "note": "regression-dispute"}, timeout=15)
ok6_create = r.status_code == 200 and r.json().get("id")
other_id = r.json().get("id") if ok6_create else None

if ok6_create:
    r = requests.post(f"{BASE}/hazards/{other_id}/dispute", headers=H, timeout=15)
    body6 = {}
    try: body6 = r.json()
    except Exception: pass
    ok6 = (r.status_code == 200 and isinstance(body6, dict)
           and body6.get("id") == other_id and body6.get("disputes", 0) >= 1)
    check("6. Bonus: POST /api/hazards/{id}/dispute still works",
          ok6,
          f"HTTP {r.status_code} disputes={body6.get('disputes')} id_match={body6.get('id')==other_id}")
    # Cleanup the regression hazard
    requests.delete(f"{BASE}/hazards/{other_id}", headers=H, timeout=10)
else:
    check("6. Bonus: POST /api/hazards/{id}/dispute still works",
          False,
          f"could not create regression hazard: HTTP {r.status_code}")

# --- Summary ---
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"\n=== SUMMARY: {passed}/{total} PASS ===")
for name, ok, detail in results:
    print(f"  {'PASS' if ok else 'FAIL'}: {name}")

sys.exit(0 if passed == total else 1)
