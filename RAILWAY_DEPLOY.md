# Convoy Backend — Railway Deploy Guide (10 minutes)

This bundle ships everything Railway needs to run the Convoy FastAPI backend with `ffmpeg` PTT amplification, MongoDB, and EAS Update support.

## What's included

```
backend/
├── Procfile           # Heroku-style web command (universal)
├── nixpacks.toml      # Railway's Nixpacks builder + ffmpeg dependency
├── railway.toml       # Railway service config (health-checks, restart policy)
├── .env.example       # Every env var you need (copy → paste into Railway UI)
├── .gitignore         # Keeps real .env out of git
├── requirements.txt
├── server.py
└── supabase_admin.py
```

## Prerequisites

- A Railway account (https://railway.app — sign up free)
- A GitHub repo containing the `backend/` folder pushed to `main`
- ~5 minutes for Railway to provision and build
- Railway free trial gives $5 credit — Convoy backend uses ~$3/mo on Hobby plan

## Step-by-step

### 1. Push the backend to GitHub

```bash
cd /path/to/your/convoy-zip
git init
git add backend RAILWAY_DEPLOY.md
git commit -m "Convoy backend — Railway-ready"
git remote add origin git@github.com:<your-user>/convoy-backend.git
git push -u origin main
```

> If you'd rather keep the whole monorepo in one place, push the full zip — Railway can deploy from a subdirectory (set **Service Settings → Root Directory** to `backend` in step 3).

### 2. Create the Railway project

1. Log into https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Pick `convoy-backend` (or your monorepo) → **Deploy Now**
3. (Monorepo only) → **Settings → Root Directory** → set to `backend` → **Save**

Railway will auto-detect `nixpacks.toml` and install `python311 + ffmpeg`. The first build takes ~3 minutes.

### 3. Add MongoDB

1. In the project canvas: **+ New** → **Database** → **MongoDB**
2. Wait ~30s for it to provision
3. Click the Mongo service → **Variables** tab → copy the `MONGO_URL` value

### 4. Configure env vars on the Convoy service

Click the Convoy service → **Variables** tab → **+ New Variable** for each line from `.env.example`:

| Variable | Value |
|---|---|
| `MONGO_URL` | paste from the Mongo plugin (or use `${{MongoDB.MONGO_URL}}`) |
| `DB_NAME` | `convoy` |
| `JWT_SECRET` | run `openssl rand -hex 32` locally, paste output |
| `GOOGLE_MAPS_KEY` | your existing key (same as `EXPO_PUBLIC_GOOGLE_MAPS_KEY`) |
| `EMERGENT_LLM_KEY` | from your `/app/backend/.env` (optional, for Whisper) |
| `OPENAI_API_KEY` | from your existing `/app/backend/.env` (optional, for TTS) |
| `SUPABASE_URL` | from your existing `/app/backend/.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | from your existing `/app/backend/.env` |
| `EMERGENT_PUSH_KEY` | leave as `placeholder` for now (push falls back to WS) |
| `SEED_DEMO_DATA` | `0` in production (skip seed) or `1` to keep demo creds |

Railway redeploys automatically every time you save a variable — wait for the green checkmark.

### 5. Grab your public URL

Click the Convoy service → **Settings** → **Networking** → **Generate Domain**.

Railway gives you something like:

```
https://convoy-backend-production.up.railway.app
```

Test it:

```bash
curl https://convoy-backend-production.up.railway.app/api/health
# → {"ok":true,"service":"convoy-api"}
```

### 6. Point the Expo app at the new backend

In the frontend:

1. `frontend/.env`
   ```
   EXPO_PUBLIC_BACKEND_URL=https://convoy-backend-production.up.railway.app
   ```

2. `frontend/eas.json` — replace all 3 occurrences:
   ```jsonc
   "env": {
     "EXPO_PUBLIC_BACKEND_URL": "https://convoy-backend-production.up.railway.app"
   }
   ```

3. `frontend/src/api.ts` — update the hardcoded fallback at line 14:
   ```ts
   const PROD_BACKEND_URL = "https://convoy-backend-production.up.railway.app";
   ```

4. Rebuild & resubmit TestFlight:
   ```bash
   cd frontend
   eas build --platform all --profile preview --clear-cache
   eas submit -p ios --latest
   eas submit -p android --latest
   ```

### 7. (Optional) Custom domain

Railway → service → **Settings → Networking → Custom Domain** → add `api.convoy.app` → follow Railway's CNAME instructions in your DNS provider.

## What you DON'T need to change

- Your Supabase project — stays the same (Realtime presence & community routes)
- Your Spotify / Google Maps / OpenAI keys — same keys, just paste them into Railway
- Your Firebase project (push notifications) — independent of the backend host

## Troubleshooting

**Build fails: `ffmpeg: command not found`**  
→ Confirm `nixpacks.toml` is in the deploy root. Railway dashboard → service → **Deployments** → click failed build → check the build log for the `Setup` phase. Should list `python311` and `ffmpeg`.

**`/api/health` returns 502 / 503**  
→ Service is still starting. Watch **Deployments → Live Logs** for `INFO: Convoy started`. Usually <30s.

**`/api/auth/login` returns 500 with KeyError: 'DB_NAME'**  
→ You missed setting `DB_NAME` in Variables. Set it to `convoy` and Railway auto-redeploys.

**Push notifications stopped firing**  
→ `EMERGENT_PUSH_KEY` defaults to `placeholder` → falls back to WS-only delivery. To enable real push, get a real Emergent Push key from your Emergent dashboard and paste it in.

**EAS build still hits the old Emergent preview URL**  
→ EAS caches env vars per-channel. Run with `--clear-cache` once after rotating `eas.json`.

## After this is done

- The Emergent preview URL (`motorist-hub.preview.emergentagent.com`) can keep running for dev work — your prod app is no longer dependent on it.
- Backend uptime is now under your control: Railway gives 99.9% SLA on the Hobby plan.
- WebSocket PTT, hazard fan-out, hail push, music broadcast all keep working — they're protocol-level and host-agnostic.
