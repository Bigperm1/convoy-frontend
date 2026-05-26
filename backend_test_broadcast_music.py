"""Tests for POST /api/community/broadcast-music + regression checks."""
import os
import sys
import time
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PASSWORD = "demo1234"
KNOWN_COMMUNITY = "d96fc987-4850-486c-8132-8601c4114aeb"  # YVRGRC seed (per review)

results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} — {detail}")
    results.append((name, ok, detail))


def main():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})

    # ---------- 1) Login ----------
    r = s.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    record("1) Login demo user", r.status_code == 200, f"http={r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        print("Cannot proceed without token")
        sys.exit(1)
    j = r.json()
    token = j.get("token") or j.get("access_token")
    user_id = j["user"]["id"]
    auth = {"Authorization": f"Bearer {token}"}
    print(f"   user_id={user_id} token_len={len(token)}")

    # ---------- 1b) Discover admin communities ----------
    admin_cids = []
    other_cid = None
    r = s.get(f"{BASE}/communities/mine", headers=auth, timeout=20)
    record("1b) GET /communities/mine", r.status_code == 200, f"http={r.status_code} count={len(r.json()) if r.status_code==200 else 'n/a'}")
    if r.status_code == 200:
        for c in r.json():
            if c.get("admin_id") == user_id:
                admin_cids.append(c["id"])
                print(f"   admin community: {c['id']} name={c.get('name')}")
            else:
                other_cid = other_cid or c["id"]
                print(f"   non-admin community: {c['id']} name={c.get('name')} admin={c.get('admin_id')}")

    # Determine which community id to use for happy path
    target_cid = KNOWN_COMMUNITY if KNOWN_COMMUNITY in admin_cids else (admin_cids[0] if admin_cids else None)
    print(f"   chosen target_cid for happy path = {target_cid}")
    if KNOWN_COMMUNITY not in admin_cids:
        print(f"   NOTE: known YVRGRC {KNOWN_COMMUNITY} NOT in admin list — using {target_cid} instead")

    if not target_cid:
        print("FATAL: demo user is admin of no community; cannot run happy path")
        sys.exit(1)

    # ---------- 2) Auth gate ----------
    r = s.post(
        f"{BASE}/community/broadcast-music",
        json={"action": "play", "community_id": target_cid, "track": {"name": "X", "artist": "Y"}},
        timeout=15,
    )
    record("2) No bearer → 401/403", r.status_code in (401, 403), f"http={r.status_code} body={r.text[:200]}")

    # ---------- 3) Invalid action ----------
    r = s.post(
        f"{BASE}/community/broadcast-music",
        headers=auth,
        json={"action": "pause", "community_id": target_cid},
        timeout=15,
    )
    ok = r.status_code == 400 and "Invalid action" in r.text
    record("3) Invalid action → 400 'Invalid action'", ok, f"http={r.status_code} body={r.text[:200]}")

    # ---------- 4) Community not found ----------
    r = s.post(
        f"{BASE}/community/broadcast-music",
        headers=auth,
        json={"action": "play", "community_id": "00000000-0000-0000-0000-000000000000", "track": {"name": "X", "artist": "Y"}},
        timeout=15,
    )
    ok = r.status_code == 404 and "Community not found" in r.text
    record("4) Community not found → 404", ok, f"http={r.status_code} body={r.text[:200]}")

    # ---------- 5) Non-admin community ----------
    if other_cid:
        r = s.post(
            f"{BASE}/community/broadcast-music",
            headers=auth,
            json={"action": "play", "community_id": other_cid, "track": {"name": "X", "artist": "Y"}},
            timeout=15,
        )
        ok = r.status_code == 403 and "Only the community admin can broadcast" in r.text
        record("5) Non-admin → 403", ok, f"http={r.status_code} body={r.text[:200]}")
    else:
        # try to create a second user, create community as them, then test demo
        rnd = os.urandom(4).hex()
        reg_email = f"broadcast-test-{rnd}@convoy.app"
        reg = s.post(
            f"{BASE}/auth/register",
            json={
                "email": reg_email,
                "password": "tester1234",
                "handle": f"BCTest{rnd}",
            },
            timeout=20,
        )
        if reg.status_code == 200:
            tok2 = reg.json().get("token")
            auth2 = {"Authorization": f"Bearer {tok2}"}
            cc = s.post(f"{BASE}/communities", headers=auth2, json={"name": f"Other-{rnd}", "is_public": True}, timeout=15)
            if cc.status_code == 200:
                other_cid_created = cc.json()["id"]
                # demo tries to broadcast to it
                r = s.post(
                    f"{BASE}/community/broadcast-music",
                    headers=auth,
                    json={"action": "play", "community_id": other_cid_created, "track": {"name": "X", "artist": "Y"}},
                    timeout=15,
                )
                ok = r.status_code == 403 and "Only the community admin can broadcast" in r.text
                record("5) Non-admin (created via 2nd user) → 403", ok, f"http={r.status_code} body={r.text[:200]}")
                # cleanup
                s.delete(f"{BASE}/communities/{other_cid_created}", headers=auth2, timeout=15)
            else:
                record("5) Non-admin community (SKIPPED)", True, f"could not create 2nd community: {cc.status_code} {cc.text[:120]}")
        else:
            record("5) Non-admin community (SKIPPED)", True, "no second community available and could not register a 2nd user")

    # ---------- 6) Happy path play ----------
    play_body = {
        "action": "play",
        "community_id": target_cid,
        "track": {
            "name": "Smooth Operator",
            "artist": "Sade",
            "albumArt": "https://x/a.jpg",
            "spotifyUri": "spotify:track:abc",
            "service": "spotify",
        },
    }
    r = s.post(f"{BASE}/community/broadcast-music", headers=auth, json=play_body, timeout=15)
    delivered_play = None
    ok = False
    if r.status_code == 200:
        body = r.json()
        delivered_play = body.get("delivered")
        ok = body.get("ok") is True and isinstance(delivered_play, int) and delivered_play >= 0
    record("6) Happy path play → 200 {ok:true, delivered:int>=0}", ok, f"http={r.status_code} body={r.text[:200]}")

    # ---------- 7) Happy path stop ----------
    r = s.post(
        f"{BASE}/community/broadcast-music",
        headers=auth,
        json={"action": "stop", "community_id": target_cid},
        timeout=15,
    )
    ok = False
    if r.status_code == 200:
        body = r.json()
        ok = body.get("ok") is True and body.get("delivered") == delivered_play
    record("7) Happy path stop → 200 same delivered", ok, f"http={r.status_code} body={r.text[:200]} expected_delivered={delivered_play}")

    # ---------- 8) Regression ----------
    r = s.get(f"{BASE}/auth/me", headers=auth, timeout=15)
    record("8a) GET /auth/me → 200", r.status_code == 200, f"http={r.status_code}")

    r = s.post(f"{BASE}/tts", headers=auth, json={"text": "test"}, timeout=15)
    record("8b) POST /tts → 503 (no quota expected)", r.status_code == 503, f"http={r.status_code} body={r.text[:200]}")

    r = s.post(
        f"{BASE}/hazards",
        headers=auth,
        json={"kind": "police", "lat": 37.5, "lng": -122.3, "note": ""},
        timeout=15,
    )
    record("8c) POST /hazards → 200", r.status_code == 200, f"http={r.status_code} body={r.text[:200]}")
    hid = None
    if r.status_code == 200:
        hid = r.json().get("id")
    if hid:
        r = s.delete(f"{BASE}/hazards/{hid}", headers=auth, timeout=15)
        record("8d) DELETE /hazards/{hid} → 200", r.status_code == 200, f"http={r.status_code} body={r.text[:200]}")
    else:
        record("8d) DELETE /hazards/{hid} (SKIPPED — no hid)", False, "")

    # ---------- summary ----------
    print("\n==== SUMMARY ====")
    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{total} passed")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name} :: {detail}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
