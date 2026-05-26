"""
Phase 1-4 Regression Suite
- No regression on existing endpoints
- Capture backend.err.log byte offset, run tests, assert zero new Tracebacks
"""
import os
import json
import requests
from pathlib import Path

BASE = "https://motorist-hub.preview.emergentagent.com/api"
ERR_LOG = "/var/log/supervisor/backend.err.log"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"

results = []

def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {detail}")

# Capture pre-test byte offset of err log
try:
    pre_size = os.path.getsize(ERR_LOG)
except FileNotFoundError:
    pre_size = 0
print(f"Pre-test err.log size: {pre_size}")

# 1. Login
r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
assert r.status_code == 200, r.text
token = r.json().get("token")
HDR = {"Authorization": f"Bearer {token}"}
record("POST /auth/login (demo)", r.status_code == 200 and bool(token), f"status={r.status_code} token_len={len(token) if token else 0}")

# 2. GET /auth/me
r = requests.get(f"{BASE}/auth/me", headers=HDR, timeout=15)
record("GET /auth/me", r.status_code == 200, f"status={r.status_code} email={r.json().get('email')}")

# 3. GET /communities/mine — should return 2 seeded communities
r = requests.get(f"{BASE}/communities/mine", headers=HDR, timeout=15)
ok = r.status_code == 200
names = []
peer_id = None
if ok:
    arr = r.json()
    names = [c.get("name") for c in arr]
    # find a peer in one of the communities
    for c in arr:
        members = c.get("members_users") or c.get("members") or []
        for m in members:
            mid = m.get("id") if isinstance(m, dict) else m
            if mid and mid != r.json()[0].get("admin_id"):
                # need a real peer != demo
                pass
record("GET /communities/mine status 200", ok, f"status={r.status_code} count={len(names)} names={names}")

# Verify seeded community names
expected = {"Bay Area Drivers", "Mountain Pass Crew"}
got = set(names)
seed_ok = expected.issubset(got)
record("GET /communities/mine contains Bay Area Drivers + Mountain Pass Crew", seed_ok, f"got={got} expected_subset={expected}")

# Find a known peer id (a member of one of the communities that isn't demo)
communities = r.json() if ok else []
me_resp = requests.get(f"{BASE}/auth/me", headers=HDR, timeout=15).json()
demo_id = me_resp.get("id")
peer_id = None
for c in communities:
    # need members - check via GET /communities/{cid}
    cid = c.get("id")
    cr = requests.get(f"{BASE}/communities/{cid}", headers=HDR, timeout=15)
    if cr.status_code == 200:
        cdata = cr.json()
        for m in cdata.get("members_users", []):
            mid = m.get("id")
            if mid and mid != demo_id:
                peer_id = mid
                break
    if peer_id:
        break
print(f"peer_id={peer_id}")

# 4. POST /hazards
r = requests.post(f"{BASE}/hazards", json={"kind": "police", "lat": 37.5, "lng": -122.3, "note": ""}, headers=HDR, timeout=15)
ok = r.status_code == 200
hid = r.json().get("id") if ok else None
record("POST /hazards", ok and bool(hid), f"status={r.status_code} id={hid}")

# 5. DELETE /hazards/{id}
if hid:
    r = requests.delete(f"{BASE}/hazards/{hid}", headers=HDR, timeout=15)
    body = r.json() if r.status_code == 200 else {}
    record("DELETE /hazards/{id}", r.status_code == 200 and body.get("ok") is True and body.get("id") == hid, f"status={r.status_code} body={body}")
else:
    record("DELETE /hazards/{id}", False, "skipped (no hid)")

# 6. POST /notifications/hail
if peer_id:
    r = requests.post(f"{BASE}/notifications/hail", json={"target_user_id": peer_id}, headers=HDR, timeout=15)
    ok = r.status_code == 200
    body = r.json() if ok else {}
    method = body.get("method")
    record("POST /notifications/hail (status 200)", ok, f"status={r.status_code} body={body}")
    record("POST /notifications/hail method == websocket_no_key", method == "websocket_no_key", f"method={method}")
else:
    record("POST /notifications/hail", False, "skipped (no peer)")

# 7. PUT /auth/push-token
r = requests.put(f"{BASE}/auth/push-token", json={"token": "test-token-xyz", "platform": "ios"}, headers=HDR, timeout=15)
ok = r.status_code == 200 and r.json().get("ok") is True
record("PUT /auth/push-token (ios)", ok, f"status={r.status_code} body={r.json()}")

# Capture post-test byte offset
try:
    post_size = os.path.getsize(ERR_LOG)
except FileNotFoundError:
    post_size = 0
new_bytes = b""
if post_size > pre_size:
    with open(ERR_LOG, "rb") as f:
        f.seek(pre_size)
        new_bytes = f.read(post_size - pre_size)
new_text = new_bytes.decode("utf-8", errors="replace")
tb_count = new_text.count("Traceback (most recent call last)")
ise_count = new_text.count("Internal Server Error")
record("Backend err.log: zero new Tracebacks", tb_count == 0, f"pre={pre_size} post={post_size} delta={post_size-pre_size}B tracebacks={tb_count} ise={ise_count}")
if tb_count > 0:
    print("--- NEW ERR LOG CONTENT ---")
    print(new_text[:5000])
    print("--- END ---")

# Summary
print("\n=== SUMMARY ===")
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
for name, ok, detail in results:
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
print(f"\n{passed}/{total} assertions passed")
