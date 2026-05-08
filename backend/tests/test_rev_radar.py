"""Rev Radar backend integration tests covering auth, location, hazards, channels, PTT, voice, ws."""
import os
import asyncio
import base64
import json
import uuid

import pytest
import requests
import websockets

BASE_URL = os.environ['EXPO_PUBLIC_BACKEND_URL'].rstrip('/') if os.environ.get('EXPO_PUBLIC_BACKEND_URL') else None
if not BASE_URL:
    # fallback: read from frontend env
    with open('/app/frontend/.env') as f:
        for line in f:
            if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
                break

WS_URL = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/ws'

DEMO = {"email": "demo@revradar.app", "password": "demo1234"}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def auth(session):
    r = session.post(f"{BASE_URL}/api/auth/login", json=DEMO, timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "token" in data and "user" in data
    return data


@pytest.fixture(scope="module")
def headers(auth):
    return {"Authorization": f"Bearer {auth['token']}", "Content-Type": "application/json"}


# ---------- Auth ----------
class TestAuth:
    def test_login_demo(self, auth):
        assert auth["user"]["email"] == DEMO["email"]
        assert auth["user"]["handle"]

    def test_login_wrong_password(self, session):
        r = session.post(f"{BASE_URL}/api/auth/login", json={"email": DEMO["email"], "password": "bad"}, timeout=20)
        assert r.status_code == 401

    def test_register_and_me(self, session):
        email = f"TEST_{uuid.uuid4().hex[:8]}@revradar.app"
        body = {"email": email, "password": "pass1234", "handle": "TESTUser", "car_make": "Mazda", "car_model": "RX7", "car_year": 1995, "car_color": "Black"}
        r = session.post(f"{BASE_URL}/api/auth/register", json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        token = d["token"]
        # me
        r2 = session.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"}, timeout=20)
        assert r2.status_code == 200
        assert r2.json()["email"] == email.lower()
        # duplicate
        r3 = session.post(f"{BASE_URL}/api/auth/register", json=body, timeout=20)
        assert r3.status_code == 400

    def test_me_no_token(self, session):
        r = session.get(f"{BASE_URL}/api/auth/me", timeout=20)
        assert r.status_code in (401, 403)

    def test_profile_update(self, session, headers):
        r = session.put(f"{BASE_URL}/api/auth/profile", headers=headers, json={"car_color": "Silver", "car_year": 1999}, timeout=20)
        assert r.status_code == 200
        assert r.json()["car_color"] == "Silver"
        assert r.json()["car_year"] == 1999


# ---------- Location ----------
class TestLocation:
    def test_update_and_nearby(self, session, headers):
        r = session.post(f"{BASE_URL}/api/location", headers=headers, json={"lat": 37.7749, "lng": -122.4194, "speed": 30, "heading": 90}, timeout=20)
        assert r.status_code == 200 and r.json().get("ok") is True
        r2 = session.get(f"{BASE_URL}/api/users/nearby", headers=headers, timeout=20)
        assert r2.status_code == 200
        assert isinstance(r2.json(), list)


# ---------- Hazards ----------
class TestHazards:
    def test_crud_and_filter(self, session, headers):
        created = []
        for kind in ["police", "road", "accident", "traffic"]:
            r = session.post(f"{BASE_URL}/api/hazards", headers=headers, json={"kind": kind, "lat": 37.77, "lng": -122.41, "note": f"TEST_{kind}"}, timeout=20)
            assert r.status_code == 200, r.text
            h = r.json()
            assert h["kind"] == kind and h["confirms"] == 1
            created.append(h["id"])
        # invalid kind
        r = session.post(f"{BASE_URL}/api/hazards", headers=headers, json={"kind": "alien", "lat": 1, "lng": 1}, timeout=20)
        assert r.status_code == 400
        # list
        r = session.get(f"{BASE_URL}/api/hazards", headers=headers, timeout=20)
        assert r.status_code == 200
        ids = [h["id"] for h in r.json()]
        for cid in created:
            assert cid in ids
        # confirm
        r = session.post(f"{BASE_URL}/api/hazards/{created[0]}/confirm", headers=headers, timeout=20)
        assert r.status_code == 200
        assert r.json()["confirms"] >= 2
        # confirm not found
        r = session.post(f"{BASE_URL}/api/hazards/nonexistent/confirm", headers=headers, timeout=20)
        assert r.status_code == 404


# ---------- Channels & PTT ----------
class TestChannels:
    def test_list_channels(self, session, headers):
        r = session.get(f"{BASE_URL}/api/channels", headers=headers, timeout=20)
        assert r.status_code == 200
        chans = r.json()
        assert len(chans) == 5
        ids = {c["id"] for c in chans}
        assert {"general", "jdm", "muscle", "euro", "trucks"} == ids

    def test_ptt_post_and_history(self, session, headers):
        audio = base64.b64encode(b"TEST_audio_bytes").decode()
        r = session.post(f"{BASE_URL}/api/ptt", headers=headers, json={"channel": "general", "audio_b64": audio, "duration_ms": 1500}, timeout=20)
        assert r.status_code == 200
        r2 = session.get(f"{BASE_URL}/api/ptt/general", headers=headers, timeout=20)
        assert r2.status_code == 200
        msgs = r2.json()
        assert any(m.get("audio_b64") == audio for m in msgs)


# ---------- Voice ----------
class TestVoice:
    def test_invalid_audio_rejected(self, session, headers):
        # Empty - base64 decode succeeds but Whisper will fail (empty file). Should be non-200.
        r = session.post(f"{BASE_URL}/api/voice/transcribe", headers=headers, json={"audio_b64": "", "mime": "audio/m4a"}, timeout=30)
        assert r.status_code != 200

    def test_invalid_b64(self, session, headers):
        r = session.post(f"{BASE_URL}/api/voice/transcribe", headers=headers, json={"audio_b64": "!!!not_base64!!!", "mime": "audio/m4a"}, timeout=30)
        # base64 lib is permissive; either 400 or 500 is acceptable (non-200)
        assert r.status_code != 200


# ---------- WebSocket ----------
class TestWebSocket:
    def test_ws_no_token_closes(self):
        async def run():
            try:
                async with websockets.connect(WS_URL, open_timeout=10) as ws:
                    # server closes 4401 - receive should raise
                    await ws.recv()
                    return None
            except Exception as e:
                return str(e)
        err = asyncio.get_event_loop().run_until_complete(run())
        assert err is not None  # connection should not stay open

    def test_ws_with_token_ping(self, auth):
        async def run():
            url = f"{WS_URL}?token={auth['token']}"
            async with websockets.connect(url, open_timeout=10) as ws:
                await ws.send(json.dumps({"type": "ping"}))
                resp = await asyncio.wait_for(ws.recv(), timeout=10)
                return json.loads(resp)
        data = asyncio.get_event_loop().run_until_complete(run())
        assert data.get("type") == "pong"
