"""Convoy v3 backend tests: communities, PTT membership gating, removed channels endpoint, hazards, auth."""
import os
import base64
import uuid
import time

import pytest
import requests

# Resolve BASE_URL from env or frontend/.env
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL') or os.environ.get('EXPO_BACKEND_URL')
if not BASE_URL:
    with open('/app/frontend/.env') as f:
        for line in f:
            if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                BASE_URL = line.split('=', 1)[1].strip().strip('"')
                break
BASE_URL = BASE_URL.rstrip('/')

DEMO = {"email": "demo@revradar.app", "password": "demo1234"}
ALEX = {"email": "alex@revradar.app", "password": "demo1234"}
SARA = {"email": "sara@revradar.app", "password": "demo1234"}


def _login(creds):
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, f"login failed: {r.text}"
    return r.json()


@pytest.fixture(scope="module")
def demo_auth():
    return _login(DEMO)

@pytest.fixture(scope="module")
def alex_auth():
    return _login(ALEX)

@pytest.fixture(scope="module")
def sara_auth():
    return _login(SARA)

@pytest.fixture(scope="module")
def demo_h(demo_auth):
    return {"Authorization": f"Bearer {demo_auth['token']}", "Content-Type": "application/json"}

@pytest.fixture(scope="module")
def alex_h(alex_auth):
    return {"Authorization": f"Bearer {alex_auth['token']}", "Content-Type": "application/json"}

@pytest.fixture(scope="module")
def sara_h(sara_auth):
    return {"Authorization": f"Bearer {sara_auth['token']}", "Content-Type": "application/json"}


# ---------- Auth (smoke) ----------
class TestAuth:
    def test_login_demo(self, demo_auth):
        assert demo_auth["user"]["email"] == DEMO["email"]
        assert demo_auth["user"]["handle"] == "DemoDriver"

    def test_login_bad_pw(self):
        r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": DEMO["email"], "password": "nope"}, timeout=20)
        assert r.status_code == 401


# ---------- Removed default channels endpoint ----------
class TestChannelsRemoved:
    def test_channels_endpoint_gone(self, demo_h):
        r = requests.get(f"{BASE_URL}/api/channels", headers=demo_h, timeout=20)
        # Should not exist anymore (v3 removed defaults). FastAPI returns 404 for unknown routes.
        assert r.status_code == 404, f"Expected 404 for removed /api/channels, got {r.status_code}"


# ---------- Communities ----------
class TestCommunitiesSeed:
    def test_demo_has_seeded_community(self, demo_h):
        r = requests.get(f"{BASE_URL}/api/communities/mine", headers=demo_h, timeout=20)
        assert r.status_code == 200
        items = r.json()
        names = [c["name"] for c in items]
        assert "Bay Area Drivers" in names, f"Expected seeded 'Bay Area Drivers' in demo's communities, got {names}"
        bay = next(c for c in items if c["name"] == "Bay Area Drivers")
        assert bay["is_admin"] is True
        assert bay["is_member"] is True
        assert bay["invite_code"]
        assert bay["member_count"] >= 1

    def test_alex_is_member_of_bay(self, alex_h):
        r = requests.get(f"{BASE_URL}/api/communities/mine", headers=alex_h, timeout=20)
        assert r.status_code == 200
        items = r.json()
        names = [c["name"] for c in items]
        assert "Bay Area Drivers" in names
        bay = next(c for c in items if c["name"] == "Bay Area Drivers")
        assert bay["is_member"] is True
        assert bay["is_admin"] is False

    def test_sara_admin_of_mountain(self, sara_h):
        r = requests.get(f"{BASE_URL}/api/communities/mine", headers=sara_h, timeout=20)
        assert r.status_code == 200
        items = r.json()
        names = [c["name"] for c in items]
        assert "Mountain Pass Crew" in names
        mp = next(c for c in items if c["name"] == "Mountain Pass Crew")
        assert mp["is_admin"] is True


class TestCommunityCRUD:
    @pytest.fixture(scope="class")
    def created(self, demo_h):
        name = f"TEST_Community_{uuid.uuid4().hex[:6]}"
        r = requests.post(f"{BASE_URL}/api/communities", headers=demo_h,
                          json={"name": name, "description": "TEST desc", "is_public": True}, timeout=20)
        assert r.status_code == 200, r.text
        c = r.json()
        assert c["name"] == name
        assert c["is_admin"] is True
        assert c["is_member"] is True
        assert c["invite_code"]
        yield c
        # Cleanup if still exists
        requests.delete(f"{BASE_URL}/api/communities/{c['id']}", headers=demo_h, timeout=20)

    def test_create_persists_in_mine(self, demo_h, created):
        r = requests.get(f"{BASE_URL}/api/communities/mine", headers=demo_h, timeout=20)
        assert r.status_code == 200
        ids = [c["id"] for c in r.json()]
        assert created["id"] in ids

    def test_search_finds_public_community(self, alex_h, created):
        # Alex searches by name
        q = created["name"][:10]
        r = requests.get(f"{BASE_URL}/api/communities/search", headers=alex_h, params={"q": q}, timeout=20)
        assert r.status_code == 200
        ids = [c["id"] for c in r.json()]
        assert created["id"] in ids

    def test_search_empty_q_returns_public(self, alex_h):
        r = requests.get(f"{BASE_URL}/api/communities/search", headers=alex_h, params={"q": ""}, timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_request_join_flow(self, sara_h, demo_h, created):
        cid = created["id"]
        # Sara requests
        r = requests.post(f"{BASE_URL}/api/communities/{cid}/request", headers=sara_h, timeout=20)
        assert r.status_code == 200
        body = r.json()
        assert body["is_pending"] is True
        # Demo (admin) sees pending in detail
        r2 = requests.get(f"{BASE_URL}/api/communities/{cid}", headers=demo_h, timeout=20)
        assert r2.status_code == 200
        assert r2.json()["pending_count"] >= 1
        assert "pending_users" in r2.json()
        sara_id = _login(SARA)["user"]["id"]
        pending_ids = [u["id"] for u in r2.json()["pending_users"]]
        assert sara_id in pending_ids

    def test_non_admin_cannot_approve(self, alex_h, created):
        cid = created["id"]
        sara_id = _login(SARA)["user"]["id"]
        r = requests.post(f"{BASE_URL}/api/communities/{cid}/approve/{sara_id}", headers=alex_h, timeout=20)
        assert r.status_code == 403

    def test_admin_approves(self, demo_h, sara_h, created):
        cid = created["id"]
        sara_id = _login(SARA)["user"]["id"]
        r = requests.post(f"{BASE_URL}/api/communities/{cid}/approve/{sara_id}", headers=demo_h, timeout=20)
        assert r.status_code == 200
        # Verify Sara is now a member
        r2 = requests.get(f"{BASE_URL}/api/communities/mine", headers=sara_h, timeout=20)
        ids = [c["id"] for c in r2.json()]
        assert cid in ids

    def test_reject_request(self, demo_h, alex_h, created):
        cid = created["id"]
        # Alex (already a public community member-eligible) requests
        # First, make sure alex is not member: demo's TEST_ community, alex is not there.
        r0 = requests.post(f"{BASE_URL}/api/communities/{cid}/request", headers=alex_h, timeout=20)
        assert r0.status_code == 200
        assert r0.json()["is_pending"] is True
        alex_id = _login(ALEX)["user"]["id"]
        r = requests.post(f"{BASE_URL}/api/communities/{cid}/reject/{alex_id}", headers=demo_h, timeout=20)
        assert r.status_code == 200
        # Verify alex is not pending or member
        r2 = requests.get(f"{BASE_URL}/api/communities/{cid}", headers=demo_h, timeout=20)
        pending_ids = [u["id"] for u in r2.json().get("pending_users", [])]
        assert alex_id not in pending_ids

    def test_join_via_invite_code(self, alex_h, created):
        code = created["invite_code"]
        r = requests.post(f"{BASE_URL}/api/communities/join", headers=alex_h, params={"code": code}, timeout=20)
        assert r.status_code == 200, r.text
        assert r.json()["is_member"] is True

    def test_join_via_bad_code(self, alex_h):
        r = requests.post(f"{BASE_URL}/api/communities/join", headers=alex_h, params={"code": "bogus_invite_xyz"}, timeout=20)
        assert r.status_code == 404

    def test_non_admin_leave(self, alex_h, created):
        cid = created["id"]
        r = requests.post(f"{BASE_URL}/api/communities/{cid}/leave", headers=alex_h, timeout=20)
        assert r.status_code == 200
        # Verify gone from alex's mine
        r2 = requests.get(f"{BASE_URL}/api/communities/mine", headers=alex_h, timeout=20)
        ids = [c["id"] for c in r2.json()]
        assert cid not in ids

    def test_admin_cannot_leave(self, demo_h, created):
        cid = created["id"]
        r = requests.post(f"{BASE_URL}/api/communities/{cid}/leave", headers=demo_h, timeout=20)
        assert r.status_code == 400

    def test_non_admin_cannot_delete(self, sara_h, created):
        cid = created["id"]
        r = requests.delete(f"{BASE_URL}/api/communities/{cid}", headers=sara_h, timeout=20)
        assert r.status_code == 403

    def test_admin_delete(self, demo_h, created):
        cid = created["id"]
        r = requests.delete(f"{BASE_URL}/api/communities/{cid}", headers=demo_h, timeout=20)
        assert r.status_code == 200
        # Verify 404 on subsequent GET
        r2 = requests.get(f"{BASE_URL}/api/communities/{cid}", headers=demo_h, timeout=20)
        assert r2.status_code == 404


# ---------- PTT membership gating ----------
class TestPTTMembership:
    def test_get_bay_community_id(self, demo_h):
        r = requests.get(f"{BASE_URL}/api/communities/mine", headers=demo_h, timeout=20)
        bay = next(c for c in r.json() if c["name"] == "Bay Area Drivers")
        TestPTTMembership.bay_id = bay["id"]
        # also Mountain Pass via search
        r2 = requests.get(f"{BASE_URL}/api/communities/search", headers=demo_h, params={"q": "Mountain"}, timeout=20)
        mp = next(c for c in r2.json() if c["name"] == "Mountain Pass Crew")
        TestPTTMembership.mp_id = mp["id"]

    def test_member_can_post_ptt(self, demo_h):
        audio = base64.b64encode(b"TEST_audio_payload_v3").decode()
        r = requests.post(f"{BASE_URL}/api/ptt", headers=demo_h,
                          json={"channel": TestPTTMembership.bay_id, "audio_b64": audio, "duration_ms": 1200}, timeout=20)
        assert r.status_code == 200, r.text
        # Verify history
        r2 = requests.get(f"{BASE_URL}/api/ptt/{TestPTTMembership.bay_id}", headers=demo_h, timeout=20)
        assert r2.status_code == 200
        assert any(m.get("audio_b64") == audio for m in r2.json())

    def test_non_member_cannot_post_ptt(self, demo_h):
        # Demo is not a member of Mountain Pass Crew
        audio = base64.b64encode(b"TEST_should_403").decode()
        r = requests.post(f"{BASE_URL}/api/ptt", headers=demo_h,
                          json={"channel": TestPTTMembership.mp_id, "audio_b64": audio, "duration_ms": 500}, timeout=20)
        assert r.status_code == 403

    def test_non_member_cannot_get_ptt(self, demo_h):
        r = requests.get(f"{BASE_URL}/api/ptt/{TestPTTMembership.mp_id}", headers=demo_h, timeout=20)
        assert r.status_code == 403

    def test_unknown_channel_403_or_404(self, demo_h):
        r = requests.post(f"{BASE_URL}/api/ptt", headers=demo_h,
                          json={"channel": "no-such-id", "audio_b64": "QUI=", "duration_ms": 0}, timeout=20)
        assert r.status_code in (403, 404)


# ---------- Hazards (still required for Map pins) ----------
class TestHazards:
    def test_create_and_list(self, demo_h):
        r = requests.post(f"{BASE_URL}/api/hazards", headers=demo_h,
                          json={"kind": "police", "lat": 37.7749, "lng": -122.4194, "note": "TEST_pin"}, timeout=20)
        assert r.status_code == 200
        h = r.json()
        assert h["kind"] == "police"
        # list
        r2 = requests.get(f"{BASE_URL}/api/hazards", headers=demo_h, timeout=20)
        assert r2.status_code == 200
        assert any(x["id"] == h["id"] for x in r2.json())
        # confirm +1
        r3 = requests.post(f"{BASE_URL}/api/hazards/{h['id']}/confirm", headers=demo_h, timeout=20)
        assert r3.status_code == 200
        assert r3.json()["confirms"] >= 2

    def test_invalid_kind(self, demo_h):
        r = requests.post(f"{BASE_URL}/api/hazards", headers=demo_h,
                          json={"kind": "ufo", "lat": 0, "lng": 0}, timeout=20)
        assert r.status_code == 400
