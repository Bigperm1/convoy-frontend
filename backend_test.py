"""Hail & push-token endpoint regression tests (review request: 2026-05).

Verifies PUT /api/auth/push-token (A1-A5) and POST /api/notifications/hail
(B1-B5) end-to-end against the public ingress URL.
"""
import os
import secrets
import time
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
DEMO_EMAIL = "demo@revradar.app"
DEMO_PASS = "demo1234"
ERR_LOG = "/var/log/supervisor/backend.err.log"

results = []

def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}")
    results.append((name, ok, detail))

def post(path, json=None, params=None, token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.post(f"{BASE}{path}", json=json, params=params, headers=headers, timeout=30)

def put(path, json=None, token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.put(f"{BASE}{path}", json=json, headers=headers, timeout=30)

def get(path, token=None, params=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.get(f"{BASE}{path}", params=params, headers=headers, timeout=30)

def delete(path, token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.delete(f"{BASE}{path}", headers=headers, timeout=30)


# --- Capture log offset BEFORE tests ---
log_offset_start = 0
try:
    log_offset_start = os.path.getsize(ERR_LOG)
except Exception as e:
    print(f"(could not stat err log: {e})")

# --- Login as demo ---
r = post("/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASS})
assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
demo_token = r.json()["token"]
demo_user = r.json()["user"]
demo_id = demo_user["id"]
record("login(demo)", True, f"user_id={demo_id}")

# =================================================================
# (A) PUT /api/auth/push-token
# =================================================================

# A1: no auth → 401
r = requests.put(f"{BASE}/auth/push-token", json={"token": "dummy", "platform": "ios"}, timeout=20)
record("A1 PUT /auth/push-token no auth -> 401",
       r.status_code == 401, f"got {r.status_code} body={r.text[:200]}")

# A2: empty token → 400 "token required"
r = put("/auth/push-token", json={"token": "", "platform": "ios"}, token=demo_token)
ok = r.status_code == 400 and r.json().get("detail") == "token required"
record("A2 empty token -> 400 'token required'", ok, f"got {r.status_code} {r.text[:200]}")

# A3: bad platform → 400 "Invalid platform"
r = put("/auth/push-token", json={"token": "fake-fcm-token-xyz", "platform": "banana"}, token=demo_token)
ok = r.status_code == 400 and r.json().get("detail") == "Invalid platform"
record("A3 invalid platform -> 400 'Invalid platform'", ok, f"got {r.status_code} {r.text[:200]}")

# A4: valid ios token → 200 {"ok":true}
r = put("/auth/push-token", json={"token": "fake-apns-token-12345", "platform": "ios"}, token=demo_token)
ok = r.status_code == 200 and r.json() == {"ok": True}
record("A4 valid ios token -> 200 {ok:true}", ok, f"got {r.status_code} {r.text[:200]}")

r = get("/auth/me", token=demo_token)
record("A4b /auth/me works after push-token write", r.status_code == 200, f"got {r.status_code}")

# A5: overwrite with different android token → 200 {"ok":true}
r = put("/auth/push-token", json={"token": "different-token-abc", "platform": "android"}, token=demo_token)
ok = r.status_code == 200 and r.json() == {"ok": True}
record("A5 idempotent overwrite (android) -> 200 {ok:true}", ok, f"got {r.status_code} {r.text[:200]}")


# =================================================================
# (B) POST /api/notifications/hail
# =================================================================

# Setup: register fresh target user
hex_id = secrets.token_hex(4)
target_email = f"hail-target-{hex_id}@convoy.app"
target_pass = "tester1234"
target_handle = f"HailTarget{hex_id}"
r = post("/auth/register", json={
    "email": target_email, "password": target_pass, "handle": target_handle,
    "car_make": "Mazda", "car_model": "RX-7", "car_year": 1993, "car_color": "White",
})
assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
target_token = r.json()["token"]
target_id = r.json()["user"]["id"]
record("setup: registered target user", True, f"email={target_email} id={target_id}")

# Get demo's admin communities
r = get("/communities/mine", token=demo_token)
assert r.status_code == 200, f"communities/mine failed: {r.status_code}"
admin_communities = [c for c in r.json() if c.get("is_admin")]
record("setup: demo has admin communities", len(admin_communities) > 0,
       f"count={len(admin_communities)} names={[c['name'] for c in admin_communities]}")

demo_community = next((c for c in admin_communities if c["name"] == "Bay Area Drivers"), admin_communities[0])
cid = demo_community["id"]
invite_code = demo_community["invite_code"]
record("setup: picked community", True, f"name={demo_community['name']} id={cid} code={invite_code}")

# Target joins via invite code
r = post("/communities/join", params={"code": invite_code}, token=target_token)
ok = r.status_code == 200 and r.json().get("is_member") is True
record("setup: target joins via invite code", ok,
       f"got {r.status_code} body={r.text[:200]}")

# Verify both members
r = get(f"/communities/{cid}", token=demo_token)
mc = r.json().get("member_count", 0) if r.status_code == 200 else -1
members_users = r.json().get("members_users", []) if r.status_code == 200 else []
both_in = any(u["id"] == target_id for u in members_users) and any(u["id"] == demo_id for u in members_users)
record("setup: community has both members", r.status_code == 200 and mc >= 2 and both_in,
       f"member_count={mc} both_in={both_in}")

# --- B1: no auth → 401 ---
r = requests.post(f"{BASE}/notifications/hail",
                  json={"target_user_id": target_id, "community_id": cid}, timeout=20)
record("B1 hail without auth -> 401", r.status_code == 401,
       f"got {r.status_code} body={r.text[:200]}")

# --- B2: random uuid (no shared community) → 403 ---
random_uuid_outsider = "11111111-2222-3333-4444-555555555555"
r = post("/notifications/hail", json={"target_user_id": random_uuid_outsider}, token=demo_token)
ok = r.status_code == 403 and r.json().get("detail") == "You must be in the same community to hail"
record("B2 hail user NOT in shared community -> 403 share-check", ok,
       f"got {r.status_code} {r.text[:200]}")

# --- B3: bogus user id (with community_id demo IS in) → still 403 (share check fails) ---
r = post("/notifications/hail",
         json={"target_user_id": "00000000-0000-0000-0000-000000000000", "community_id": cid},
         token=demo_token)
ok = r.status_code == 403 and r.json().get("detail") == "You must be in the same community to hail"
record("B3 hail bogus user id w/ community_id -> 403 (share-check)", ok,
       f"got {r.status_code} {r.text[:200]}")

# --- B4: happy path, target has no push_token → method:'websocket' ---
r = post("/notifications/hail", json={"target_user_id": target_id, "community_id": cid}, token=demo_token)
body = r.json() if r.status_code == 200 else {}
ok = (r.status_code == 200 and body.get("ok") is True and body.get("method") == "websocket")
record("B4 happy path no push_token -> 200 {ok:true, method:'websocket'}", ok,
       f"got {r.status_code} body={body}")

# --- B5a: register push_token for target ---
r = put("/auth/push-token",
        json={"token": "fake-fcm-token-target", "platform": "android"},
        token=target_token)
record("B5a target registers push_token -> 200 {ok:true}",
       r.status_code == 200 and r.json() == {"ok": True},
       f"got {r.status_code} {r.text[:200]}")

time.sleep(0.5)

# --- B5b: hail with token + EMERGENT_PUSH_KEY=placeholder → method:'websocket_no_key' ---
r = post("/notifications/hail", json={"target_user_id": target_id, "community_id": cid}, token=demo_token)
body = r.json() if r.status_code == 200 else {}
ok = (r.status_code == 200 and body.get("ok") is True and body.get("method") == "websocket_no_key")
record("B5b hail target_w_token + placeholder push key -> method='websocket_no_key'",
       ok, f"got {r.status_code} body={body}")


# =================================================================
# (C) Regression check
# =================================================================
r = get("/auth/me", token=demo_token)
record("C1 GET /auth/me -> 200", r.status_code == 200, f"got {r.status_code}")

r = get("/communities/mine", token=demo_token)
record("C2 GET /communities/mine -> 200", r.status_code == 200, f"got {r.status_code}")

r = post("/hazards", json={"kind": "police", "lat": 37.5, "lng": -122.3, "note": ""}, token=demo_token)
hazard_ok = r.status_code == 200 and "id" in r.json()
hazard_id = r.json().get("id") if hazard_ok else None
record("C3 POST /hazards -> 200 with id", hazard_ok, f"got {r.status_code} id={hazard_id}")
if hazard_id:
    rd = delete(f"/hazards/{hazard_id}", token=demo_token)
    record("C3b DELETE /hazards/{id} cleanup -> 200", rd.status_code == 200, f"got {rd.status_code}")

r = post("/community/broadcast-music",
         json={"action": "stop", "community_id": cid},
         token=demo_token)
ok = r.status_code == 200 and r.json().get("ok") is True
record("C4 POST /community/broadcast-music (stop) -> 200 {ok:true}",
       ok, f"got {r.status_code} body={r.text[:200]}")


# =================================================================
# Log scan
# =================================================================
try:
    with open(ERR_LOG, "rb") as f:
        f.seek(log_offset_start)
        new_bytes = f.read()
    new_text = new_bytes.decode("utf-8", errors="replace")
    has_traceback = "Traceback (most recent call last)" in new_text
    has_500 = "Internal Server Error" in new_text
    record("C5 No new Traceback in err log during tests",
           not has_traceback,
           f"new_bytes={len(new_bytes)} has_traceback={has_traceback} has_500={has_500}")
    if has_traceback:
        print("\n--- TRACEBACK SNIPPET ---")
        print(new_text[:3000])
        print("--- END ---\n")
except Exception as e:
    record("C5 log scan", False, f"error reading log: {e}")


# Cleanup target user's push_token noise leaves no harm; can't delete user (no endpoint).

print("\n=================== SUMMARY ===================")
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"{passed}/{total} PASS")
for name, ok, detail in results:
    if not ok:
        print(f"  FAIL: {name} :: {detail}")
print("===============================================")
