# Convoy — Emergent Native Deployment Checklist

> Code-side prep is **done**. The actual one-click deploy is a UI action only you can do.

---

## What I have already done for you

| ✅ | Item |
|---|---|
| ✓ | Backend `_transcribe_audio()` refactored to a swappable provider — prefers `OPENAI_API_KEY` (direct OpenAI SDK), falls back to `EMERGENT_LLM_KEY` (`emergentintegrations`). Verified via regression tests. |
| ✓ | `requirements.txt` pins `openai==1.99.9` so the direct-SDK path is portable to Railway/Render later. |
| ✓ | `eas.json` skeleton created — has `production` profile with placeholder `EXPO_PUBLIC_BACKEND_URL` ready for you to swap to your Emergent `.sh` URL. |
| ✓ | `deployment_agent` static-analysis pass: **PASS** — no hardcoded URLs, no in-memory state that won't survive container restart, CORS=`*`, `load_dotenv()` correct, all secrets from env, MongoDB-only (compatible with Emergent managed Mongo). |
| ✓ | All `EXPO_PUBLIC_BACKEND_URL` reads go through `process.env.EXPO_PUBLIC_BACKEND_URL` — single source of truth in `frontend/.env`. |

---

## What ONLY you can do (now)

### Step 1 · Click **Deploy** in the Emergent UI
Open the Emergent chat sidebar → look for the **Deploy** button → click it. Pick the FastAPI backend deployment.

This will:
- Spin up your backend on Emergent's managed infra (Kubernetes)
- Provision a managed MongoDB and inject `MONGO_URL` + `DB_NAME`
- Hand you back a public URL like `https://convoy-xxxx.emergent.sh`

### Step 2 · Set the deployment env vars in the Emergent panel
Before the first request, paste these into the deployment env panel:

| Var | Value | Why |
|---|---|---|
| `JWT_SECRET` | (generate a long random string) | Auth signing — DO NOT reuse the dev one |
| `EMERGENT_LLM_KEY` | (your existing key) | Whisper transcription — **OR** set `OPENAI_API_KEY` instead |
| `OPENAI_API_KEY` | _(optional)_ | If set, takes precedence — portable across hosts |
| `SUPABASE_URL` | (your existing) | Realtime + DB |
| `SUPABASE_SERVICE_ROLE_KEY` | (your existing) | Server-side Supabase writes |
| `SUPABASE_ANON_KEY` | (your existing) | Used by the `supabase_admin` module |
| `EXTERNAL_FEED_NA_URL` | _(optional)_ | Override `rtproxy-na.waze.com` if you have a working proxy |
| `EXTERNAL_FEED_ROW_URL` | _(optional)_ | Same, for ROW |

Mongo URL/DB name will be **auto-injected** by Emergent — don't touch.

### Step 3 · Toggle "Keep-Alive" in the deployment settings
In the deployment dashboard there's a toggle to keep the container warm (prevents cold starts on the next request after idle). Critical for your field test from a moving car. Turn it **on**.

> If you don't see that exact label, look for "Always-on", "No-sleep", "Min instances ≥ 1", or similar — same idea.

### Step 4 · Send me the deployed `.sh` URL
Paste it in chat. I'll then:
1. Update `/app/frontend/.env` → `EXPO_PUBLIC_BACKEND_URL=https://your-app.sh`
2. Update `/app/frontend/eas.json` → `production.env.EXPO_PUBLIC_BACKEND_URL`
3. Restart Expo
4. Run a quick smoke test (login, profile update, presence channel join) against the new URL
5. Report back ✅

### Step 5 · (Field-test only) Build a dev client OR scan the Expo Go QR code
- For Expo Go: pull-to-reload on your phone — the new `EXPO_PUBLIC_BACKEND_URL` propagates instantly.
- For TestFlight / EAS internal: `eas build --profile production --platform ios` will pick up `eas.json` automatically.

---

## Cell-service field test — what to verify

| Flow | Expected | Where it persists |
|---|---|---|
| Login (`demo@revradar.app/demo1234`) | 200 + JWT, Garage shows your reset values | MongoDB |
| Drive on the Map → speed > 0 | Speedometer HUD updates real-time | client-side only |
| Drive faster than your record (every 60s sync) | Garage "Top Cruise Speed" bumps up after re-opening | MongoDB `top_speed_record` |
| 2nd phone joins same community | Both cars appear on each other's map within ~1.5s | Supabase Realtime Presence |
| Tap another driver's car icon | PeerModal shows their PB chip | Supabase Presence payload (live) |
| Voice command "navigate to Half Moon Bay" | Route renders + TTS confirms | OpenAI Whisper → Google Directions |

---

## Rollback / portability

If you ever want to leave Emergent for Railway / Render:
1. **Code is already ready** — the OpenAI SDK fallback works on any Python 3.11 host.
2. Push `/app/backend` to GitHub.
3. Add this `Dockerfile`:
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
```
4. Set the same env vars in Railway/Render dashboard.
5. Switch `MONGO_URL` to a MongoDB Atlas cluster.
6. Set `OPENAI_API_KEY` (skip `EMERGENT_LLM_KEY` outside Emergent).
