"""
Backend test: PTT server-side amplification (Bug 9).
Verifies POST /api/ptt amplifies audio via ffmpeg, falls back gracefully on
failure, enforces auth + community membership, and never 5xx's.
"""
import os
import sys
import json
import base64
import subprocess
import tempfile
import uuid as _uuid
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PWD = "demo1234"

ERR_LOG = "/var/log/supervisor/backend.err.log"


def _err_offset() -> int:
    try:
        return os.path.getsize(ERR_LOG)
    except Exception:
        return 0


def _err_since(offset: int) -> str:
    try:
        with open(ERR_LOG, "rb") as f:
            f.seek(offset)
            return f.read().decode("utf-8", errors="replace")
    except Exception as e:
        return f"<could not read err log: {e}>"


results = []


def record(name: str, ok: bool, detail: str):
    results.append((name, ok, detail))
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name} :: {detail[:300]}")


def main():
    pre_offset = _err_offset()
    print(f"Pre-test err.log offset = {pre_offset}")

    # ---- 1. Login -----------------------------------------------------------
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PWD}, timeout=20)
    if r.status_code != 200:
        record("login", False, f"HTTP {r.status_code} body={r.text[:200]}")
        return
    body = r.json()
    token = body.get("token") or body.get("access_token")
    if not token:
        record("login", False, f"no token in body keys={list(body.keys())}")
        return
    record("login", True, f"got JWT (len={len(token)})")
    H = {"Authorization": f"Bearer {token}"}

    # ---- 2. Communities mine -----------------------------------------------
    r = requests.get(f"{BASE}/communities/mine", headers=H, timeout=15)
    if r.status_code != 200:
        record("communities_mine", False, f"HTTP {r.status_code}")
        return
    comms = r.json()
    if not isinstance(comms, list) or not comms:
        record("communities_mine", False, f"empty list body={r.text[:200]}")
        return
    # Prefer one where demo is admin (Bay Area Drivers) but any membership works.
    cid = None
    for c in comms:
        if c.get("is_admin") is True:
            cid = c.get("id")
            cname = c.get("name", "?")
            break
    if not cid:
        cid = comms[0].get("id")
        cname = comms[0].get("name", "?")
    record("communities_mine", True, f"picked community '{cname}' id={cid} (of {len(comms)})")

    # ---- 3. AUTH GATE -------------------------------------------------------
    r = requests.post(
        f"{BASE}/ptt",
        json={"channel": cid, "audio_b64": "short", "duration_ms": 100},
        timeout=15,
    )
    record(
        "auth_gate_401",
        r.status_code == 401,
        f"HTTP {r.status_code} body={r.text[:200]}",
    )

    # ---- 4. MEMBERSHIP GATE -------------------------------------------------
    fake_cid = "00000000-0000-0000-0000-000000000000"
    r = requests.post(
        f"{BASE}/ptt",
        headers=H,
        json={"channel": fake_cid, "audio_b64": "shortbase64", "duration_ms": 100},
        timeout=15,
    )
    ok = (
        r.status_code == 403
        and isinstance(r.json(), dict)
        and r.json().get("detail") == "Not a member of this community"
    )
    record(
        "membership_gate_403",
        ok,
        f"HTTP {r.status_code} body={r.text[:200]}",
    )

    # ---- 5. EMPTY AUDIO SHORT-CIRCUIT --------------------------------------
    r = requests.post(
        f"{BASE}/ptt",
        headers=H,
        json={"channel": cid, "audio_b64": "", "duration_ms": 0},
        timeout=15,
    )
    j = {}
    try:
        j = r.json()
    except Exception:
        pass
    ok = (
        r.status_code == 200
        and j.get("ok") is True
        and isinstance(j.get("id"), str)
        and len(j.get("id", "")) >= 8
    )
    empty_msg_id = j.get("id") if ok else None
    record(
        "empty_audio_short_circuit_200",
        ok,
        f"HTTP {r.status_code} body={r.text[:200]}",
    )

    # ---- 6. HAPPY PATH: real m4a clip via ffmpeg ----------------------------
    src_m4a = "/tmp/test_ptt_src.m4a"
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-c:a", "aac", "-b:a", "64k", "-ac", "1",
                src_m4a,
            ],
            check=True, timeout=15,
        )
        with open(src_m4a, "rb") as f:
            src_bytes = f.read()
        src_b64 = base64.b64encode(src_bytes).decode("ascii")
        record(
            "synth_real_m4a",
            True,
            f"generated {len(src_bytes)} bytes m4a (b64 len={len(src_b64)})",
        )
    except Exception as e:
        record("synth_real_m4a", False, f"ffmpeg gen failed: {e}")
        src_b64 = None
        src_bytes = b""

    happy_id = None
    if src_b64:
        r = requests.post(
            f"{BASE}/ptt",
            headers=H,
            json={"channel": cid, "audio_b64": src_b64, "duration_ms": 1000},
            timeout=30,
        )
        try:
            j = r.json()
        except Exception:
            j = {}
        ok = (
            r.status_code == 200
            and j.get("ok") is True
            and isinstance(j.get("id"), str)
        )
        happy_id = j.get("id") if ok else None
        record(
            "happy_path_real_audio_200",
            ok,
            f"HTTP {r.status_code} id={happy_id} body={r.text[:200]}",
        )

    # ---- 6b. Fetch stored, decode, ffprobe, confirm differs -----------------
    if happy_id:
        r = requests.get(f"{BASE}/ptt/{cid}", headers=H, timeout=20)
        if r.status_code != 200:
            record("fetch_history", False, f"HTTP {r.status_code}")
        else:
            history = r.json()
            stored = None
            for m in history:
                if m.get("id") == happy_id:
                    stored = m
                    break
            if not stored:
                record(
                    "fetch_history",
                    False,
                    f"id {happy_id} not in history (count={len(history)})",
                )
            else:
                record("fetch_history", True, f"found id in history of {len(history)}")
                stored_b64 = stored.get("audio_b64", "")
                try:
                    stored_bytes = base64.b64decode(stored_b64)
                except Exception as e:
                    stored_bytes = b""
                    record("decode_stored", False, f"b64 decode failed: {e}")
                else:
                    record(
                        "decode_stored",
                        len(stored_bytes) > 0,
                        f"decoded {len(stored_bytes)} bytes",
                    )

                # Byte-differs check (proves amplification mutated the audio)
                differs = stored_bytes != src_bytes and len(stored_bytes) > 0
                record(
                    "boosted_differs_from_input",
                    differs,
                    f"src_len={len(src_bytes)} stored_len={len(stored_bytes)} differ={differs}",
                )

                # ffprobe — confirm valid AAC
                out_path = "/tmp/got_boosted.m4a"
                with open(out_path, "wb") as f:
                    f.write(stored_bytes)
                try:
                    probe = subprocess.run(
                        [
                            "ffprobe", "-v", "error",
                            "-show_streams", "-of", "json", out_path,
                        ],
                        capture_output=True, text=True, timeout=10,
                    )
                    probe_json = json.loads(probe.stdout or "{}")
                    streams = probe_json.get("streams", [])
                    codec_ok = (
                        probe.returncode == 0
                        and len(streams) == 1
                        and streams[0].get("codec_name") == "aac"
                        and streams[0].get("codec_type") == "audio"
                    )
                    record(
                        "ffprobe_valid_aac",
                        codec_ok,
                        f"rc={probe.returncode} streams={len(streams)} codec={streams[0].get('codec_name') if streams else None} channels={streams[0].get('channels') if streams else None} bit_rate={streams[0].get('bit_rate') if streams else None}",
                    )
                except Exception as e:
                    record("ffprobe_valid_aac", False, f"ffprobe failed: {e}")

    # ---- 7. CORRUPT AUDIO FAILURE PASSTHROUGH -------------------------------
    junk = b"this is not an m4a file at all" * 20  # ~600 bytes
    junk_b64 = base64.b64encode(junk).decode("ascii")
    r = requests.post(
        f"{BASE}/ptt",
        headers=H,
        json={"channel": cid, "audio_b64": junk_b64, "duration_ms": 500},
        timeout=20,
    )
    try:
        j = r.json()
    except Exception:
        j = {}
    ok = (
        r.status_code == 200
        and j.get("ok") is True
        and isinstance(j.get("id"), str)
    )
    record(
        "corrupt_audio_passthrough_200",
        ok,
        f"HTTP {r.status_code} body={r.text[:200]}",
    )

    # ---- 8. REGRESSION: GET /api/ptt/{cid} ----------------------------------
    r = requests.get(f"{BASE}/ptt/{cid}", headers=H, timeout=15)
    ok = r.status_code == 200 and isinstance(r.json(), list)
    history = r.json() if ok else []
    ids_present = {m.get("id") for m in history}
    expected_ids = {empty_msg_id, happy_id}
    expected_ids.discard(None)
    matched = expected_ids.issubset(ids_present)
    record(
        "regression_get_history_200",
        ok and matched,
        f"HTTP {r.status_code} history_count={len(history)} expected_ids_present={matched}",
    )

    # ---- 9. BACKEND LOG SCAN ------------------------------------------------
    new_log = _err_since(pre_offset)
    has_traceback = "Traceback (most recent call last)" in new_log
    has_500 = "Internal Server Error" in new_log
    amplify_warnings = new_log.count("PTT amplify failed") + new_log.count("PTT amplify exception")
    ok = (not has_traceback) and (not has_500)
    record(
        "log_scan_no_tracebacks",
        ok,
        f"new_bytes={len(new_log)} tracebacks={has_traceback} 500s={has_500} amplify_warnings={amplify_warnings} (warnings expected on corrupt-audio test)",
    )
    if not ok:
        print("---- new err.log content ----")
        print(new_log[-4000:])
        print("---- end ----")

    # Summary
    print("\n===== SUMMARY =====")
    fails = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"  {'OK ' if ok else 'XX '} {name}")
    print(f"\nTotal: {len(results)}  Pass: {len(results)-len(fails)}  Fail: {len(fails)}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
