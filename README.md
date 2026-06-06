# Convoy

Convoy is a community driving app for car enthusiasts — a shared live map, turn-by-turn navigation, walkie-talkie comms, and music, built around the people you drive with. Spin up a community, see your crew's cars move on the map in real time, navigate together, flag police and hazards for each other, talk over push-to-talk, and share routes, songs, and channels with a tap.

- **Platforms:** iOS + Android (React Native / Expo), with a partial web build
- **Current version:** 1.1.10 (`com.sw0rdfisch.convoy`)

## Features

- **Live convoy map** — your community's cars rendered as their real paint/body, moving in real time, with a heading-up chase cam.
- **Turn-by-turn navigation** — Google Routes with traffic-aware alternates, spoken guidance, automatic rerouting, and a full-screen destination search (recents + "drive to a friend").
- **Hazard & police reporting** — Waze-style community alerts with crowd voting ("still there?" / "gone") and pass-by prompts.
- **Push-to-talk comms** — per-community walkie-talkie with proximity-scaled audio quality and a live transmissions feed.
- **Apple Music** — browse your library, search the catalog, and play in-app (iOS), with an admin broadcast option.
- **Sharing** — send a route, song, or comms channel to specific crew members; recipients can load it straight into their own map/player.
- **Voice commands** — hands-free reporting and navigation via speech-to-text + intent parsing.
- **Garage & profile** — your car's make/model/paint, plus a personal top-speed record.

## Tech stack

**App** (`frontend/`)
- Expo SDK 54, React Native 0.81, React 19, expo-router (typed routes), New Architecture enabled
- `react-native-maps` (Google) for native maps; Google Places (New) for search; Google Routes API v2 for directions
- `@lomray/react-native-apple-music` (MusicKit) for in-app playback
- WebSockets for live location/comms; optional Supabase Realtime for presence + hazard fan-out
- TypeScript (strict), Reanimated, Gesture Handler, Expo Notifications, expo-av, expo-haptics

**Backend** (`backend/` — dev copy; deployed separately, see below)
- FastAPI (Python), MongoDB, JWT auth, WebSockets
- Expo push notifications; OpenAI (Whisper transcription + TTS) and Gemini (voice intent) proxies
- Hosted on Render

## Project structure

```
frontend/                 ← this repo
├── frontend/             Expo app (the React Native client)
│   ├── app/              expo-router screens (map, talk, music, hub, garage, settings…)
│   ├── src/              components, hooks, API client, navigation/voice/comms logic
│   └── assets/           icons, brand marks, vehicle paints, sounds
├── backend/              FastAPI server (dev copy — see Deployment)
├── DEPLOY.md             build & release notes
├── HAZARDS_SUPABASE_SETUP.md
├── TESTFLIGHT_CHECKLIST.md
├── supabase_schema.sql   optional Supabase tables (presence/hazards)
└── backend_test_*.py     backend endpoint test scripts
```

The live backend is deployed from a **separate** repo (`Bigperm1/convoy-backend`); the `backend/` folder here is the development copy kept in sync with it.

## Getting started

### App

```bash
cd frontend/frontend
yarn install
npx expo start
```

Several core features rely on native modules (maps, Apple Music, notifications), so use a **development build** (`eas build --profile development`) rather than Expo Go for full functionality.

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload
```

## Configuration

Secrets are provided via environment variables / EAS secrets — **do not commit keys**.

- **App:** Google Maps API key, backend API base URL, and (optionally) Supabase URL + anon key.
- **Backend:** `MONGO_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

## Build & release

- **Over-the-air update** (JS-only changes):
  ```bash
  cd frontend/frontend
  eas update --branch preview --message "..."
  ```
- **Native build + store submit:** `eas build` / `eas submit` (the `deploy.bat` helper at the repo parent wraps the common iOS/Android flows).
- **Backend:** push the `convoy-backend` repo — Render auto-deploys on commit (start command is configured in the Render dashboard).

## License

Private project. All rights reserved.
