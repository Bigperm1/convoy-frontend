"""Quick regression test for swappable voice transcription provider + top_speed_record."""
import os
import base64
import requests

BASE = "https://motorist-hub.preview.emergentagent.com/api"
EMAIL = "demo@revradar.app"
PWD = "demo1234"


def login():
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PWD}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    return data["token"]


def test_voice_empty_audio():
    """Test 1: No-regression sanity — empty audio returns 400."""
    token = login()
    r = requests.post(
        f"{BASE}/voice/transcribe",
        headers={"Authorization": f"Bearer {token}"},
        json={"audio_b64": "", "mime": "audio/m4a"},
        timeout=15,
    )
    print(f"[Test 1] empty audio_b64 → {r.status_code} {r.text[:200]}")
    assert r.status_code == 400, f"expected 400 but got {r.status_code} ({r.text[:200]})"
    detail = r.json().get("detail", "")
    assert "too short" in detail.lower() or "audio" in detail.lower(), f"unexpected detail: {detail}"
    print("[Test 1] PASS — route alive, validation/auth path not regressed")


def test_voice_provider_swap():
    """Test 2: Auth gate / provider resolution — should NOT 500 on KeyError/ImportError."""
    token = login()
    # 2000 char base64 string of "A"s — decodes to ~1500 bytes (each 4 chars → 3 bytes)
    audio_b64 = "A" * 2000
    decoded_len = len(base64.b64decode(audio_b64 + "==="[: (4 - len(audio_b64) % 4) % 4], validate=False))
    print(f"[Test 2] sending audio_b64 len={len(audio_b64)} → ~{decoded_len} bytes")
    r = requests.post(
        f"{BASE}/voice/transcribe",
        headers={"Authorization": f"Bearer {token}"},
        json={"audio_b64": audio_b64, "mime": "audio/m4a"},
        timeout=60,
    )
    print(f"[Test 2] status={r.status_code} body={r.text[:400]}")
    body_lower = r.text.lower()
    # Forbidden errors that indicate broken provider swap logic
    forbidden_markers = [
        "keyerror: 'emergent_llm_key'",
        "keyerror: \"emergent_llm_key\"",
        "importerror",
        "attributeerror",
        "no module named",
        "no llm key configured",
    ]
    for m in forbidden_markers:
        assert m not in body_lower, f"FORBIDDEN marker '{m}' found in response"

    # Acceptable outcomes:
    if r.status_code == 200:
        j = r.json()
        assert "text" in j and "intent" in j, f"200 but missing text/intent: {j}"
        print("[Test 2] PASS — 200 with {text, intent} shape (Whisper accepted noise)")
    elif r.status_code == 500:
        detail = r.json().get("detail", "")
        # 500 is acceptable IFF it's a Whisper-rejected-audio kind of error,
        # not a KeyError / ImportError / AttributeError / config-missing error.
        assert detail.startswith("Transcribe failed:"), f"500 with unexpected detail: {detail}"
        print(f"[Test 2] PASS — 500 'Transcribe failed' (Whisper rejected noise as invalid audio): {detail[:200]}")
    else:
        # 400 (e.g. 'Audio too short' if our padding didn't decode > 1000 bytes) is also fine — still proves route reached
        if r.status_code == 400:
            print(f"[Test 2] NOTE — 400 returned (audio still too short on server decode). Acceptable.")
        else:
            raise AssertionError(f"unexpected status {r.status_code}: {r.text[:300]}")


def test_top_speed_record_regression():
    """Test 3: Light re-verify of top_speed_record persistence."""
    token = login()
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.put(f"{BASE}/auth/profile", headers=headers, json={"top_speed_record": 144.0}, timeout=15)
    print(f"[Test 3] PUT /auth/profile {{top_speed_record:144.0}} → {r.status_code}")
    assert r.status_code == 200, f"expected 200 got {r.status_code}: {r.text[:200]}"
    j = r.json()
    assert j.get("top_speed_record") == 144.0, f"expected top_speed_record==144.0 got {j.get('top_speed_record')}"
    print("[Test 3] PASS — top_speed_record updated to 144.0 and reflected in response")


if __name__ == "__main__":
    print(f"Testing against {BASE}")
    print("=" * 80)
    failures = []
    for fn in (test_voice_empty_audio, test_voice_provider_swap, test_top_speed_record_regression):
        try:
            fn()
        except AssertionError as e:
            print(f"[FAIL] {fn.__name__}: {e}")
            failures.append(fn.__name__)
        except Exception as e:
            print(f"[ERROR] {fn.__name__}: {type(e).__name__}: {e}")
            failures.append(fn.__name__)
        print("-" * 80)
    print("=" * 80)
    if failures:
        print(f"FAILED: {failures}")
        raise SystemExit(1)
    print("ALL 3 REGRESSION TESTS PASSED")
