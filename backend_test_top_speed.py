"""Backend tests for PUT /api/auth/profile top_speed_record flow."""
import os
import sys
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"

results = []
def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    results.append((status, name, detail))
    print(f"[{status}] {name}{(' — ' + detail) if detail else ''}")

# 1. Login
r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
check("1. POST /auth/login → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
data = r.json() if r.status_code == 200 else {}
token = data.get("token")
user = data.get("user", {})
check("1. login response has token (JWT)", isinstance(token, str) and len(token) > 50 and token.count(".") == 2,
      f"token len={len(token) if isinstance(token,str) else 'n/a'}")
check("1. login response has user", isinstance(user, dict) and user.get("email") == EMAIL,
      f"user email={user.get('email')}")

if not token:
    print("Cannot continue without token")
    sys.exit(1)

H = {"Authorization": f"Bearer {token}"}

# 2. Auth gate — PUT without authorization
r = requests.put(f"{BASE}/auth/profile", json={"top_speed_record": 142.5}, timeout=15)
check("2. PUT /auth/profile without bearer → 401", r.status_code == 401, f"got {r.status_code}")
try:
    detail = r.json().get("detail")
    check("2. detail == 'Not authenticated'", detail == "Not authenticated", f"detail={detail}")
except Exception:
    check("2. response is JSON", False, r.text[:120])

# 3. Set top speed = 142.5
r = requests.put(f"{BASE}/auth/profile", json={"top_speed_record": 142.5}, headers=H, timeout=15)
check("3. PUT top_speed_record=142.5 → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
body = r.json() if r.status_code == 200 else {}
required_keys = ["id", "email", "handle", "car_make", "car_model", "car_year", "car_color",
                 "car_type", "top_speed_record", "lat", "lng", "heading", "speed"]
missing = [k for k in required_keys if k not in body]
check("3. response shape == public_user (all required keys present)", len(missing) == 0,
      f"missing={missing} body_keys={list(body.keys())}")
check("3. response.top_speed_record == 142.5", body.get("top_speed_record") == 142.5,
      f"got {body.get('top_speed_record')!r}")

# 4. Persistence via GET /auth/me
r = requests.get(f"{BASE}/auth/me", headers=H, timeout=15)
check("4. GET /auth/me → 200", r.status_code == 200, f"got {r.status_code}")
me = r.json() if r.status_code == 200 else {}
check("4. /auth/me response.top_speed_record == 142.5", me.get("top_speed_record") == 142.5,
      f"got {me.get('top_speed_record')!r}")

# 5. Update with smaller value — API blindly stores
r = requests.put(f"{BASE}/auth/profile", json={"top_speed_record": 99.0}, headers=H, timeout=15)
check("5. PUT top_speed_record=99.0 → 200", r.status_code == 200, f"got {r.status_code}")
body = r.json() if r.status_code == 200 else {}
check("5. response.top_speed_record == 99.0 (API blindly stores)", body.get("top_speed_record") == 99.0,
      f"got {body.get('top_speed_record')!r}")

# 6. Partial update preserves top_speed_record
r = requests.put(f"{BASE}/auth/profile", json={"car_color": "Midnight Purple"}, headers=H, timeout=15)
check("6. PUT car_color=Midnight Purple → 200", r.status_code == 200, f"got {r.status_code}")
body = r.json() if r.status_code == 200 else {}
check("6. response.car_color == 'Midnight Purple'", body.get("car_color") == "Midnight Purple",
      f"got {body.get('car_color')!r}")
check("6. response.top_speed_record == 99.0 (preserved, not zeroed)",
      body.get("top_speed_record") == 99.0, f"got {body.get('top_speed_record')!r}")

# 6b. Confirm via GET /auth/me
r = requests.get(f"{BASE}/auth/me", headers=H, timeout=15)
check("6. GET /auth/me → 200 after partial update", r.status_code == 200, f"got {r.status_code}")
me = r.json() if r.status_code == 200 else {}
check("6. /auth/me top_speed_record == 99.0", me.get("top_speed_record") == 99.0,
      f"got {me.get('top_speed_record')!r}")
check("6. /auth/me car_color == 'Midnight Purple'", me.get("car_color") == "Midnight Purple",
      f"got {me.get('car_color')!r}")

# Cleanup: reset values so future tests start fresh-ish (best effort)
try:
    requests.put(f"{BASE}/auth/profile", json={"top_speed_record": 0.0, "car_color": "Red"},
                 headers=H, timeout=10)
except Exception:
    pass

# Summary
fails = [r for r in results if r[0] == "FAIL"]
print("\n========== SUMMARY ==========")
print(f"Total: {len(results)}, Pass: {len(results) - len(fails)}, Fail: {len(fails)}")
if fails:
    print("\nFailures:")
    for _, name, detail in fails:
        print(f"  - {name}: {detail}")
sys.exit(0 if not fails else 1)
