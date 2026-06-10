# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Convoy — an Expo / React Native (New Architecture, RN 0.81, React 19) app for driving in a group ("convoy"): a live map with peer car positions and crowd-sourced hazards, turn-by-turn navigation, push-to-talk comms, a "Nova" voice assistant, music control (Apple Music / Spotify), and CarPlay + Android Auto surfaces. iOS, Android, and web (via `react-native-web`) all build from one codebase.

## Commands

```bash
yarn install            # postinstall runs patch-package automatically (see Patches below)
yarn start              # expo start (Metro dev server); --android / --ios / --web variants exist
yarn lint               # expo lint (eslint-config-expo, flat config)
```

```bash
yarn typecheck          # tsc --noEmit — required clean gate before every publish (see Release Discipline)
```

There is **no test suite**. `metro.config.js` caps `maxWorkers` to 2 and uses an on-disk FileStore cache in `.metro-cache`.

### Builds & releases (EAS)

```bash
eas build --profile development|preview|production --platform ios|android
eas update --channel preview|production          # OTA JS-only update (no native rebuild)
eas submit --profile production --platform ios|android
```

- Three profiles in `eas.json`: `development` (dev client, iOS simulator), `preview` (internal APK / ad-hoc), `production` (store bundle, `autoIncrement` on Android).
- `runtimeVersion.policy = "appVersion"` — an OTA `eas update` only reaches builds whose `app.json` `version` matches. Bump native `version` when you ship native changes; OTA-only fixes go to existing builds with the same version.
- Recent commits prefixed `OTA:` are JS-only changes shipped via `eas update`.

## Architecture

### Routing & auth gating (Expo Router)

File-based routing under `app/`. `typedRoutes` is on. Three groups:
- `app/index.tsx` — the gate. Redirects to `/(app)/map` (session active), `/onboarding` (first launch), or `/(auth)/login`. It waits for both `useAuth().user` and an AsyncStorage read before redirecting so the wrong screen never flashes.
- `app/(auth)/*` — login / signup / onboarding (unauthenticated).
- `app/(app)/*` — the authenticated app, a `Tabs` layout. **`app/(app)/map.tsx` is the center of gravity (~3000 lines)** — it owns location, the WebSocket, presence, navigation state, hazards, and feeds the CarPlay surface. Most map/nav feature work happens here or in the `src/` modules it composes.

`src/auth.tsx` exposes `AuthProvider` / `useAuth`. `user` is `undefined` while loading, `null` when signed out — preserve this three-state contract. Token lives in AsyncStorage (`src/api.ts`) and is auto-attached as a Bearer header by the axios interceptor.

### Two backends

1. **Custom backend** (`src/api.ts`) — axios client at `BACKEND_URL` (Render). Auth, profiles, hazards REST fallback, push-token registration, voice transcription/intent, and a WebSocket (`wsUrl(token)`) for live convoy state. `formatErr()` is the standard error-to-string helper (note its special-case for cold-start timeouts — the Render backend sleeps).
2. **Supabase** (`src/supabase.ts`) — Realtime channels for live peer presence/avatars (`src/convoyPresence.ts`) and hazard broadcast. The anon key is RLS-protected and intentionally shipped in the client.

### Env vars & the hardcoded-fallback pattern (important)

`EXPO_PUBLIC_*` vars come from `.env` (local) and `eas.json` `env` blocks (builds). EAS has historically failed to inject these at bundle time, silently killing search/routes/presence. So `src/api.ts` and `src/supabase.ts` deliberately keep **hardcoded production fallbacks** (`PROD_BACKEND_URL`, `PROD_MAPS_KEY`, `FALLBACK_SUPABASE_*`) and read `process.env.X || FALLBACK`. This redundancy is intentional — read the long comments before "cleaning it up." Supabase client creation gates on `Platform`, **not** `typeof window` (which is undefined on Hermes and would disable presence on device).

### Event buses (pub/sub)

Cross-screen coordination uses lightweight module-level `Set<Listener>` buses instead of global state: `voiceBus`, `hailBus`, `shareBus`, `shareInbox`, `globalPtt`, `livePtt`, `commsRead`. Pattern is always `emit(x)` + `subscribe(fn): () => void`. `voiceBus` is how recognized voice intents reach whichever screen handles them (e.g. `map.tsx` subscribes to act on "navigate to …").

### Navigation engine

`src/nav.ts` — uses the **Google Routes API v2** (`computeRoutes`), not the legacy Directions API. Provides `fetchRoutes`, the `useTurnByTurn` step machine, distance/ETA formatters, and TTS announcements (which duck the music player via `applePlayer`). `src/novaGreeting.ts` prepares/plays the Nova voice greeting at route start.

### Voice / Nova

`src/useVoice.ts` records audio (quality scales with convoy proximity tier, see `src/proximityAudio.ts`), sends it to the backend for transcription + intent, and emits onto `voiceBus`. TTS is `expo-speech` / Nova. `VoiceController`, `VoiceFAB`, `VoiceTabButton` are the UI entry points.

### Map rendering

`src/ConvoyMap.tsx` (native, `react-native-maps`) and `src/ConvoyMap.web.tsx` (`@vis.gl/react-google-maps`) are platform variants behind one import. **`react-native-maps` is pinned and excluded from `expo install` reconciliation** (`package.json` `expo.install.exclude`) — don't let a tool bump it.

### CarPlay / Android Auto

`src/carplay/ConvoyCarPlay.tsx` is a **presentation surface only** — no nav engine or voice of its own. It mirrors the live route/peers from `map.tsx` into `carStore.ts`. iOS gets Map/Comms/Music tabs; Android Auto is navigation-only by platform rule. `.web.tsx` stubs keep `react-native-carplay` (which runs native side effects at import) out of the web bundle; it's also loaded lazily and only when the native module exists. Discoverability requires the config plugins below.

### Config plugins (`plugins/`)

Custom Expo config plugins run at prebuild: `withConvoyAndroidAuto.js` (injects the `com.google.android.gms.car.application` meta-data + `automotive_app_desc.xml` so Android Auto lists the app) and `withConvoyCarPlay.js`. Registered in `app.json` `plugins`.

### Patches (`patches/`, patch-package)

Native deps are patched at install time via `patch-package` (postinstall hook): `react-native-carplay` (RN 0.81 / New Arch null-safety fixes — see recent commits) and `@lomray/react-native-apple-music`. If you change a patched package, regenerate with `npx patch-package <name>`.

## Conventions

- TypeScript `strict`. Path aliases: `@/*` → repo root, `~/*` → `src/*` (though most code uses relative imports).
- Dark UI only (`userInterfaceStyle: "dark"`). Shared colors in `src/theme.ts` (`COLORS`); frosted panels via `src/Glass.tsx` (`expo-blur`).
- User preferences persist through `src/settings.ts` (`useSettings` / `getSettings` / `updateSettings`, AsyncStorage key `convoy.settings.v3` — bump the key version on breaking shape changes).
- Platform-specific files use the `.ios.ts` / `.web.tsx` suffix convention (e.g. `applePlayer.ios.ts` vs `applePlayer.ts`, `ConvoyMap.web.tsx`).
- Many native APIs throw on web — guard with `Platform.OS !== "web"` (push notifications, CarPlay, audio recording all do this).

## Release Discipline

- **OTAs always ship from the `preview` branch**: `eas update --branch preview`. Both the production and preview channels track the `preview` branch, so a single publish reaches both.
- **`yarn typecheck` must pass clean before every publish.** This is a required gate — do not publish on a failing or skipped typecheck.
- **Never run `eas submit`** (TestFlight or production) without the maintainer's explicit go-ahead.
- **EAS native builds cost money.** Batch scope before recommending one, and verify `yarn typecheck` passes, the lockfile (`yarn.lock`) is consistent, and references resolve first.
- **OTAs require testers to cold-start the app twice** to pick up the update (first launch fetches it, second launch runs it).
