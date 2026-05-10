"""
Backend test for community admin & member endpoints.

Verifies:
1. GET /api/communities/{cid} always returns `members_users` with proper field set
   - includes is_admin per row, email visible only to admin or self
2. GET /api/communities/{cid} performs one-time admin backfill when admin_id missing
3. PUT /api/communities/{cid} — admin-only, supports partial updates of
   {name, description, is_public, logo_b64, walkie_enabled, music_enabled, map_enabled}
"""
import os
import uuid
import secrets
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"

results = []

def record(label: str, ok: bool, detail: str = ""):
    results.append((label, ok, detail))
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {label} :: {detail}")


def auth_headers(token: str):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def login(email, password):
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": password}, timeout=15)
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]


def register(email, password, handle, **car):
    body = {"email": email, "password": password, "handle": handle, **car}
    r = requests.post(f"{BASE}/auth/register", json=body, timeout=15)
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]


def main():
    # ---------- Setup: user A (demo), user B (fresh) ----------
    print("\n=== SETUP ===")
    tokA, userA = login("demo@revradar.app", "demo1234")
    record("setup.login.demo", bool(tokA), f"userA.id={userA['id']} handle={userA.get('handle')}")

    # Register user B with random email
    rand = secrets.token_hex(4)
    email_b = f"bob-test-{rand}@convoy.app"
    pwd_b = "bobtest1234"
    handle_b = f"BobTest{rand[:4]}"
    tokB, userB = register(email_b, pwd_b, handle_b, car_make="Ford", car_model="Mustang",
                            car_year=2021, car_color="Red", car_type="coupe")
    record("setup.register.userB", bool(tokB),
           f"userB.id={userB['id']} email={email_b} handle={handle_b}")

    # ---------- Step 1: A creates community ----------
    print("\n=== STEP 1: A creates community 'Backend Test Crew' ===")
    cname = f"Backend Test Crew {rand}"
    r = requests.post(f"{BASE}/communities", json={
        "name": cname,
        "description": "automated backend admin/member test",
        "is_public": True,
    }, headers=auth_headers(tokA), timeout=15)
    record("1.POST /communities status==200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        return summarize()
    com = r.json()
    cid = com["id"]
    record("1.is_admin==true (creator)", com.get("is_admin") is True, f"is_admin={com.get('is_admin')}")
    record("1.admin_id==userA.id",
           com.get("admin_id") == userA["id"],
           f"admin_id={com.get('admin_id')} expected {userA['id']}")
    record("1.admin_handle==A.handle",
           com.get("admin_handle") == userA.get("handle"),
           f"admin_handle={com.get('admin_handle')} expected {userA.get('handle')}")

    # ---------- Step 2: GET as A → members_users len 1 with A's email ----------
    print("\n=== STEP 2: GET /communities/{cid} as user A ===")
    r = requests.get(f"{BASE}/communities/{cid}", headers=auth_headers(tokA), timeout=15)
    record("2.GET as A status==200", r.status_code == 200, f"got {r.status_code}")
    d = r.json() if r.status_code == 200 else {}
    mu = d.get("members_users")
    record("2.members_users is list", isinstance(mu, list), f"type={type(mu).__name__}")
    record("2.members_users length==1", isinstance(mu, list) and len(mu) == 1, f"len={len(mu) if isinstance(mu,list) else 'NA'}")
    if isinstance(mu, list) and len(mu) >= 1:
        m0 = mu[0]
        record("2.members_users[0].id==A.id", m0.get("id") == userA["id"], f"id={m0.get('id')}")
        record("2.members_users[0].is_admin==true", m0.get("is_admin") is True, f"is_admin={m0.get('is_admin')}")
        record("2.members_users[0].email==A.email (self/admin)",
               m0.get("email") == userA.get("email"),
               f"email={m0.get('email')} expected {userA.get('email')}")
        # Required fields present
        required_fields = {"id", "handle", "car_make", "car_model", "car_color", "car_type", "is_admin"}
        record("2.members_users[0] has required fields",
               required_fields.issubset(m0.keys()),
               f"keys={sorted(m0.keys())}")

    # ---------- Step 3: B requests join, A approves ----------
    print("\n=== STEP 3: B requests join, A approves ===")
    r = requests.post(f"{BASE}/communities/{cid}/request", headers=auth_headers(tokB), timeout=15)
    record("3a.POST /request as B status==200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")

    r = requests.post(f"{BASE}/communities/{cid}/approve/{userB['id']}",
                      headers=auth_headers(tokA), timeout=15)
    record("3b.POST /approve as A status==200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    record("3b.member_count==2 post-approve",
           body.get("member_count") == 2,
           f"member_count={body.get('member_count')}")

    # ---------- Step 4: GET as B → members_users redaction logic ----------
    print("\n=== STEP 4: GET /communities/{cid} as user B (non-admin) ===")
    r = requests.get(f"{BASE}/communities/{cid}", headers=auth_headers(tokB), timeout=15)
    record("4.GET as B status==200", r.status_code == 200, f"got {r.status_code}")
    d = r.json() if r.status_code == 200 else {}
    mu = d.get("members_users")
    record("4.members_users length==2", isinstance(mu, list) and len(mu) == 2, f"len={len(mu) if isinstance(mu,list) else 'NA'}")
    if isinstance(mu, list) and len(mu) == 2:
        by_id = {m["id"]: m for m in mu}
        mA = by_id.get(userA["id"])
        mB = by_id.get(userB["id"])
        record("4.mA exists in members_users", mA is not None, f"keys={list(by_id.keys())}")
        record("4.mB exists in members_users", mB is not None, "")
        if mA and mB:
            record("4.mA.is_admin==true", mA.get("is_admin") is True, f"is_admin={mA.get('is_admin')}")
            record("4.mB.is_admin==false", mB.get("is_admin") is False, f"is_admin={mB.get('is_admin')}")
            record("4.mA.email is NULL (admin-only, viewer is non-admin)",
                   mA.get("email") is None,
                   f"mA.email={mA.get('email')!r}")
            record("4.mB.email == B.email (self)",
                   mB.get("email") == email_b,
                   f"mB.email={mB.get('email')!r} expected {email_b}")

    # ---------- Step 5: PUT as B (non-admin) → 403 ----------
    print("\n=== STEP 5: PUT /communities/{cid} as B (non-admin) ===")
    r = requests.put(f"{BASE}/communities/{cid}", json={"description": "hack"},
                     headers=auth_headers(tokB), timeout=15)
    record("5.PUT as B status==403", r.status_code == 403,
           f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 403:
        record("5.detail mentions Admin", "Admin" in r.text, f"body={r.text[:200]}")

    # ---------- Step 6: PUT as A with description ----------
    print("\n=== STEP 6: PUT /communities/{cid} as A — update description ===")
    new_desc = f"new desc test {rand}"
    r = requests.put(f"{BASE}/communities/{cid}", json={"description": new_desc},
                     headers=auth_headers(tokA), timeout=15)
    record("6.PUT description as A status==200", r.status_code == 200,
           f"got {r.status_code} body={r.text[:200]}")
    j = r.json() if r.status_code == 200 else {}
    record("6.response.description updated",
           j.get("description") == new_desc,
           f"description={j.get('description')!r} expected {new_desc!r}")
    # Verify via GET
    r = requests.get(f"{BASE}/communities/{cid}", headers=auth_headers(tokA), timeout=15)
    d = r.json() if r.status_code == 200 else {}
    record("6.GET confirms description persisted",
           d.get("description") == new_desc,
           f"description={d.get('description')!r}")

    # ---------- Step 7: PUT as A — name + walkie_enabled ----------
    print("\n=== STEP 7: PUT /communities/{cid} as A — rename + disable walkie ===")
    new_name = f"Renamed {rand}"
    r = requests.put(f"{BASE}/communities/{cid}",
                     json={"name": new_name, "walkie_enabled": False},
                     headers=auth_headers(tokA), timeout=15)
    record("7.PUT name+walkie_enabled as A status==200", r.status_code == 200,
           f"got {r.status_code} body={r.text[:200]}")
    j = r.json() if r.status_code == 200 else {}
    record("7.response.name updated",
           j.get("name") == new_name,
           f"name={j.get('name')!r} expected {new_name!r}")
    record("7.response.walkie_enabled==False",
           j.get("walkie_enabled") is False,
           f"walkie_enabled={j.get('walkie_enabled')!r}")
    record("7.description still preserved (partial update)",
           j.get("description") == new_desc,
           f"description={j.get('description')!r}")

    # ---------- Step 8: Admin backfill via direct Mongo manipulation ----------
    print("\n=== STEP 8: Admin backfill via Mongo (insert community w/o admin_id) ===")
    try:
        from pymongo import MongoClient
        from dotenv import dotenv_values
        env = dotenv_values("/app/backend/.env")
        mongo_url = env.get("MONGO_URL") or os.environ.get("MONGO_URL")
        db_name = env.get("DB_NAME") or os.environ.get("DB_NAME") or "test_database"
        client = MongoClient(mongo_url)
        mdb = client[db_name]

        backfill_cid = str(uuid.uuid4())
        invite = secrets.token_urlsafe(6)
        mdb.communities.insert_one({
            "id": backfill_cid,
            "name": f"Orphan Community {rand}",
            "description": "no admin set on purpose",
            "is_public": True,
            "admin_id": None,
            "admin_handle": "",
            "members": [userA["id"], userB["id"]],  # A first → should become admin
            "pending_requests": [],
            "invite_code": invite,
            "created_at": "2024-01-01T00:00:00+00:00",
        })
        record("8.inserted orphan community", True, f"cid={backfill_cid}, members[0]={userA['id']}")

        # GET it (as B, who is a member) → should trigger backfill
        r = requests.get(f"{BASE}/communities/{backfill_cid}", headers=auth_headers(tokB), timeout=15)
        record("8.GET orphan community status==200", r.status_code == 200,
               f"got {r.status_code}")
        d = r.json() if r.status_code == 200 else {}
        record("8.admin_id backfilled to first member (userA)",
               d.get("admin_id") == userA["id"],
               f"admin_id={d.get('admin_id')} expected {userA['id']}")
        record("8.admin_handle backfilled to A.handle",
               d.get("admin_handle") == userA.get("handle"),
               f"admin_handle={d.get('admin_handle')} expected {userA.get('handle')}")

        # Verify backfill persisted in Mongo
        fresh = mdb.communities.find_one({"id": backfill_cid})
        record("8.Mongo persisted admin_id",
               fresh and fresh.get("admin_id") == userA["id"],
               f"mongo.admin_id={fresh.get('admin_id') if fresh else None}")

        # Cleanup
        mdb.communities.delete_one({"id": backfill_cid})
    except Exception as e:
        record("8.admin backfill test", False, f"exception: {e}")

    # ---------- Cleanup: delete test community ----------
    print("\n=== CLEANUP ===")
    r = requests.delete(f"{BASE}/communities/{cid}", headers=auth_headers(tokA), timeout=15)
    record("cleanup.DELETE community", r.status_code == 200, f"got {r.status_code}")

    return summarize()


def summarize():
    print("\n\n========== SUMMARY ==========")
    passes = [r for r in results if r[1]]
    fails = [r for r in results if not r[1]]
    for label, ok, detail in results:
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {label} :: {detail}")
    print(f"\nTOTAL: {len(passes)}/{len(results)} pass, {len(fails)} fail")
    return len(fails) == 0


if __name__ == "__main__":
    ok = main()
    raise SystemExit(0 if ok else 1)
