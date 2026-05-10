"""
End-to-end backend test for the walkie-talkie (PTT) realtime broadcast.

Verifies the fix in /app/backend/server.py:
  - post_ptt now calls ws_manager.broadcast_to_users(members_excluding_sender, msg)
    with the FULL audio_b64 payload (was previously stripped).
  - WSManager.broadcast_to_users restricts the fan-out to the given user_ids only.

We use the in-cluster URL http://localhost:8001 since the public ingress strips
WebSocket Upgrade headers on some paths. All endpoints are under /api/*.
"""

import asyncio
import base64
import json
import time
import uuid
import httpx
import websockets

BASE = "http://localhost:8001/api"
WS_BASE = "ws://localhost:8001/api/ws"


def _rand_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}@convoy.app"


async def register(client: httpx.AsyncClient, email: str, password: str, handle: str) -> dict:
    """Register a fresh test user with only {email,password,handle} — no car fields."""
    r = await client.post(f"{BASE}/auth/register", json={
        "email": email, "password": password, "handle": handle,
    })
    r.raise_for_status()
    return r.json()


async def login(client: httpx.AsyncClient, email: str, password: str) -> dict:
    r = await client.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    return r.json()


async def open_ws(token: str):
    """Open a WS, return the connection. Caller is responsible for closing."""
    url = f"{WS_BASE}?token={token}"
    ws = await websockets.connect(url, open_timeout=8, ping_interval=None)
    return ws


async def drain_for(ws, seconds: float = 1.5) -> list:
    """Collect any frames that arrive within `seconds`."""
    frames = []
    end = time.time() + seconds
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            break
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
            try:
                frames.append(json.loads(msg))
            except Exception:
                frames.append({"_raw": msg})
        except asyncio.TimeoutError:
            break
        except Exception:
            break
    return frames


async def main():
    results = []  # list of (name, ok, detail)

    def record(name, ok, detail=""):
        results.append((name, ok, detail))
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {name}: {detail}")

    async with httpx.AsyncClient(timeout=20.0) as http:
        print("\n=== Step 1: Register user1 + user2 with minimal payload ===")
        u1_email = _rand_email("ptt-u1")
        u2_email = _rand_email("ptt-u2")
        u3_email = _rand_email("ptt-u3")  # outsider, NOT in community
        try:
            reg1 = await register(http, u1_email, "tester1234", "PTTUser1")
            tok1, uid1 = reg1["token"], reg1["user"]["id"]
            record("register user1 returns JWT with only {email,password,handle}",
                   bool(tok1) and tok1.count(".") == 2,
                   f"uid={uid1[:8]}.. tok_len={len(tok1)}")
        except Exception as e:
            record("register user1", False, f"exception: {e}")
            return _summary(results)

        try:
            reg2 = await register(http, u2_email, "tester1234", "PTTUser2")
            tok2, uid2 = reg2["token"], reg2["user"]["id"]
            record("register user2", bool(tok2), f"uid={uid2[:8]}..")
        except Exception as e:
            record("register user2", False, f"exception: {e}")
            return _summary(results)

        try:
            reg3 = await register(http, u3_email, "tester1234", "PTTOutsider")
            tok3, uid3 = reg3["token"], reg3["user"]["id"]
            record("register user3 (outsider)", bool(tok3), f"uid={uid3[:8]}..")
        except Exception as e:
            record("register user3", False, f"exception: {e}")
            return _summary(results)

        print("\n=== Step 2: User1 creates a community ===")
        try:
            r = await http.post(f"{BASE}/communities",
                                headers={"Authorization": f"Bearer {tok1}"},
                                json={"name": f"PTT Test {uuid.uuid4().hex[:6]}",
                                      "description": "PTT realtime test", "is_public": True})
            r.raise_for_status()
            comm = r.json()
            cid = comm["id"]
            invite_code = comm["invite_code"]
            record("POST /api/communities (user1) returns 200 + is_admin=true",
                   comm.get("is_admin") is True and bool(cid),
                   f"cid={cid[:8]}.. members={comm.get('member_count')}")
        except Exception as e:
            record("create community", False, f"exception: {e}")
            return _summary(results)

        print("\n=== Step 3: Add user2 to the community ===")
        # Spec mentions POST /api/communities/{id}/join — which doesn't exist.
        # Real endpoints: request → admin approves, OR /communities/join?code=...
        # Use the invite-code path since it's a single call by user2 (becomes member instantly).
        try:
            r = await http.post(f"{BASE}/communities/join",
                                headers={"Authorization": f"Bearer {tok2}"},
                                params={"code": invite_code})
            r.raise_for_status()
            j = r.json()
            record("user2 joins community via invite code",
                   j.get("is_member") is True,
                   f"member_count={j.get('member_count')}")
        except Exception as e:
            record("user2 joins community", False, f"exception: {e}")
            return _summary(results)

        # Sanity: user3 is NOT a member
        try:
            r = await http.get(f"{BASE}/communities/{cid}",
                               headers={"Authorization": f"Bearer {tok3}"})
            j = r.json() if r.status_code == 200 else {}
            ok = (r.status_code == 200 and j.get("is_member") is False)
            record("user3 is NOT a member of community", ok,
                   f"status={r.status_code} is_member={j.get('is_member')}")
        except Exception as e:
            record("verify user3 non-member", False, f"exception: {e}")

        print("\n=== Step 4: Open WebSockets for user1, user2, user3 ===")
        ws1 = ws2 = ws3 = None
        try:
            ws1 = await open_ws(tok1)
            ws2 = await open_ws(tok2)
            ws3 = await open_ws(tok3)
            record("WS open for user1, user2, user3", True,
                   "all 3 sockets connected to ws://localhost:8001/api/ws")
        except Exception as e:
            record("WS open", False, f"exception: {e}")
            for w in (ws1, ws2, ws3):
                if w:
                    try: await w.close()
                    except Exception: pass
            return _summary(results)

        # Tiny drain to clear any handshake frames
        await asyncio.sleep(0.2)
        await drain_for(ws1, 0.2)
        await drain_for(ws2, 0.2)
        await drain_for(ws3, 0.2)

        print("\n=== Step 5: User1 POSTs /api/ptt with non-empty audio_b64 ===")
        # 16 bytes encoded → 24-char base64 — non-empty, deterministic
        original_audio_b64 = base64.b64encode(b"PTT-TEST-PAYLOAD").decode()
        assert len(original_audio_b64) > 0

        # Start collectors BEFORE the POST so we don't miss the frame
        collect_ws1 = asyncio.create_task(drain_for(ws1, 2.5))
        collect_ws2 = asyncio.create_task(drain_for(ws2, 2.5))
        collect_ws3 = asyncio.create_task(drain_for(ws3, 2.5))

        # Tiny delay to ensure collectors are blocked on recv()
        await asyncio.sleep(0.1)

        try:
            r = await http.post(f"{BASE}/ptt",
                                headers={"Authorization": f"Bearer {tok1}"},
                                json={"channel": cid, "audio_b64": original_audio_b64,
                                      "duration_ms": 1000})
            r.raise_for_status()
            ptt_resp = r.json()
            record("POST /api/ptt returns 200 + {ok:true, id}",
                   ptt_resp.get("ok") is True and bool(ptt_resp.get("id")),
                   f"ptt_id={ptt_resp.get('id','')[:8]}..")
            ptt_id = ptt_resp.get("id")
        except Exception as e:
            record("POST /api/ptt", False, f"exception: {e}")
            for t in (collect_ws1, collect_ws2, collect_ws3): t.cancel()
            for w in (ws1, ws2, ws3):
                try: await w.close()
                except Exception: pass
            return _summary(results)

        frames_ws1 = await collect_ws1
        frames_ws2 = await collect_ws2
        frames_ws3 = await collect_ws3

        print("\n=== Step 6: CRITICAL — user2 receives ptt frame with FULL audio_b64 ===")
        ptt_frames_ws2 = [f for f in frames_ws2 if isinstance(f, dict) and f.get("type") == "ptt"]
        if not ptt_frames_ws2:
            record("user2 receives a {type:'ptt'} WS frame", False,
                   f"no ptt frame found. all frames received: {frames_ws2}")
        else:
            frame = ptt_frames_ws2[0]
            msg = frame.get("message") or {}
            audio_in_frame = msg.get("audio_b64", "")
            record("user2 receives a {type:'ptt'} WS frame", True,
                   f"got 1 ptt frame; message.id={msg.get('id','')[:8]}..")
            # CRITICAL ASSERTION: full original base64 is intact
            record("FRAME audio_b64 equals ORIGINAL (not stripped to empty)",
                   audio_in_frame == original_audio_b64,
                   f"expected len={len(original_audio_b64)} got len={len(audio_in_frame)}")
            # Shape sanity
            shape_ok = all(k in msg for k in ("id", "channel", "user_id", "handle",
                                              "audio_b64", "duration_ms", "created_at"))
            record("FRAME message has full PTT shape (id/channel/user_id/handle/audio_b64/duration_ms/created_at)",
                   shape_ok,
                   f"keys={sorted(msg.keys())}")
            record("FRAME message.channel == community_id",
                   msg.get("channel") == cid,
                   f"channel={msg.get('channel','')[:8]}..")
            record("FRAME message.user_id == sender (user1)",
                   msg.get("user_id") == uid1,
                   f"sender uid={uid1[:8]}.. msg.user_id={msg.get('user_id','')[:8]}..")

        print("\n=== Step 7: User1 (sender) does NOT receive their own PTT echo ===")
        ptt_frames_ws1 = [f for f in frames_ws1 if isinstance(f, dict) and f.get("type") == "ptt"]
        record("user1 (sender) does NOT receive own PTT echo",
               len(ptt_frames_ws1) == 0,
               f"ptt frames on sender's WS: {len(ptt_frames_ws1)} (expected 0)")

        print("\n=== Step 8: User3 (non-member) does NOT receive the PTT frame ===")
        ptt_frames_ws3 = [f for f in frames_ws3 if isinstance(f, dict) and f.get("type") == "ptt"]
        record("user3 (non-member) does NOT receive the PTT frame (community-scoped fan-out)",
               len(ptt_frames_ws3) == 0,
               f"ptt frames on outsider's WS: {len(ptt_frames_ws3)} (expected 0)")

        print("\n=== Step 9: GET /api/ptt/{cid} (user1) — history persists with audio ===")
        try:
            r = await http.get(f"{BASE}/ptt/{cid}",
                               headers={"Authorization": f"Bearer {tok1}"})
            r.raise_for_status()
            history = r.json()
            row = next((x for x in history if x.get("id") == ptt_id), None)
            record("GET /api/ptt/{cid} contains the saved transmission",
                   row is not None,
                   f"history_count={len(history)} found_id={bool(row)}")
            if row is not None:
                record("HISTORY row.audio_b64 == ORIGINAL (full payload persisted)",
                       row.get("audio_b64") == original_audio_b64,
                       f"persisted_len={len(row.get('audio_b64',''))}")
        except Exception as e:
            record("GET /api/ptt/{cid}", False, f"exception: {e}")

        # Close sockets cleanly
        for w in (ws1, ws2, ws3):
            try: await w.close()
            except Exception: pass

        # Cleanup community (best-effort)
        try:
            await http.delete(f"{BASE}/communities/{cid}",
                              headers={"Authorization": f"Bearer {tok1}"})
        except Exception:
            pass

    return _summary(results)


def _summary(results):
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    for name, ok, detail in results:
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {name}")
        if not ok:
            print(f"         → {detail}")
    print(f"\n{passed} passed, {failed} failed out of {len(results)} assertions")
    return failed == 0


if __name__ == "__main__":
    ok = asyncio.run(main())
    exit(0 if ok else 1)
