"""
POST /api/tts endpoint test — 8 functional assertions.

In this env OPENAI_API_KEY is NOT set, so the TTS endpoint should return 503
('TTS not configured') — that's the documented graceful-degradation path the
frontend's nav.ts relies on (to fall back to expo-speech).
"""
import os
import sys
import json
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"

results = []
def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}" + (f" — {detail}" if detail else "")
    print(line)
    results.append((name, ok, detail))

# ---- 1. Login ----
r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
ok = r.status_code == 200 and ("token" in r.json())
token = r.json().get("token", "") if r.status_code == 200 else ""
record("1. Login demo creds → 200 + JWT", ok,
       f"status={r.status_code}, token_len={len(token)}")
if not ok:
    print("Cannot continue without token")
    sys.exit(1)

H = {"Authorization": f"Bearer {token}"}

# Capture log size BEFORE TTS calls so we can scope assertion #8 to only
# new log lines produced during this test run (pre-existing tracebacks from
# previous tests should not pollute this assertion).
LOG_PATHS = ["/var/log/supervisor/backend.err.log", "/var/log/supervisor/backend.out.log"]
log_offsets = {}
for p in LOG_PATHS:
    try:
        log_offsets[p] = os.path.getsize(p)
    except OSError:
        log_offsets[p] = 0

# ---- 2. Auth gate ----
r = requests.post(f"{BASE}/tts", json={"text": "In 200 meters, turn left."}, timeout=15)
ok = r.status_code in (401, 403)
record("2. POST /tts WITHOUT bearer → 401/403", ok,
       f"status={r.status_code} body={r.text[:120]}")

# ---- 3. Empty (whitespace) text → 400 ----
r = requests.post(f"{BASE}/tts", headers=H, json={"text": "   "}, timeout=15)
detail = ""
try: detail = r.json().get("detail", "")
except Exception: pass
ok = r.status_code == 400 and detail == "text required"
record("3. Whitespace text → 400 'text required'", ok,
       f"status={r.status_code} detail='{detail}'")

# ---- 4. Missing text field → 422 ----
r = requests.post(f"{BASE}/tts", headers=H, json={}, timeout=15)
ok = r.status_code == 422
record("4. Missing text field → 422 (Pydantic validation)", ok,
       f"status={r.status_code} body={r.text[:160]}")

# ---- 5. No OPENAI_API_KEY → 503 ----
r = requests.post(f"{BASE}/tts", headers=H,
                  json={"text": "In 200 meters, turn left onto Main Street."},
                  timeout=20)
detail = ""
try: detail = r.json().get("detail", "")
except Exception: pass
ok = r.status_code == 503 and detail == "TTS not configured"
record("5. No OPENAI_API_KEY → 503 'TTS not configured'", ok,
       f"status={r.status_code} detail='{detail}'")

# ---- 6. Custom voice acceptance — still 503 ----
r = requests.post(f"{BASE}/tts", headers=H,
                  json={"text": "Take the next right.", "voice": "shimmer"},
                  timeout=20)
detail = ""
try: detail = r.json().get("detail", "")
except Exception: pass
ok = r.status_code == 503 and detail == "TTS not configured"
record("6. Custom voice 'shimmer' accepted → 503", ok,
       f"status={r.status_code} detail='{detail}'")

# ---- 7. Regression — existing endpoints unaffected ----
# 7a GET /auth/me
r = requests.get(f"{BASE}/auth/me", headers=H, timeout=15)
ok = r.status_code == 200 and r.json().get("email") == EMAIL
record("7a. GET /auth/me → 200", ok, f"status={r.status_code}")

# 7b POST /hazards
hz_body = {"kind": "police", "lat": 37.5, "lng": -122.3, "note": ""}
r = requests.post(f"{BASE}/hazards", headers=H, json=hz_body, timeout=15)
ok = r.status_code == 200 and "id" in r.json()
hid = r.json().get("id", "") if r.status_code == 200 else ""
record("7b. POST /hazards → 200", ok, f"status={r.status_code} id={hid}")

# 7c DELETE /hazards/{hid}
r = requests.delete(f"{BASE}/hazards/{hid}", headers=H, timeout=15) if hid else None
if r is not None:
    ok = r.status_code == 200 and r.json().get("ok") is True
    record("7c. DELETE /hazards/{id} → 200", ok, f"status={r.status_code} body={r.text[:120]}")
else:
    record("7c. DELETE /hazards/{id} → 200", False, "no hid captured")

# ---- 8. Backend logs — no 500 stack traces / TTS ERROR spam (scoped to THIS run) ----
bad_phrases = ["Traceback (most recent call last)", "TTS failed", "Internal Server Error"]
flagged = []
for p in LOG_PATHS:
    if not os.path.exists(p):
        continue
    try:
        start = log_offsets.get(p, 0)
        with open(p, "r", errors="replace") as f:
            f.seek(start)
            new_chunk = f.read()
        for phrase in bad_phrases:
            if phrase in new_chunk:
                # Show the line for context
                for line in new_chunk.splitlines():
                    if phrase in line:
                        flagged.append(f"{os.path.basename(p)}::'{phrase}' line='{line[:200]}'")
                        break
    except Exception as e:
        flagged.append(f"{p}::read_error::{e}")

ok = len(flagged) == 0
record("8. No 500 stack traces / TTS ERROR spam (scoped to this run)", ok,
       f"flagged={flagged}" if flagged else "logs clean for this run")

# ---- Summary ----
print("\n" + "=" * 60)
passed = sum(1 for _, ok, _ in results if ok)
print(f"RESULT: {passed}/{len(results)} assertions PASS")
print("=" * 60)
sys.exit(0 if passed == len(results) else 1)
