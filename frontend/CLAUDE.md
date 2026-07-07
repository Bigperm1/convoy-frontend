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
- `runtimeVersion` is a **FIXED string** (currently `"1.1.11"`), NOT the `appVersion` policy. An OTA `eas update` reaches every build whose `runtimeVersion` matches this string, regardless of the marketing `version`. So you can bump `version` freely for JS/OTA releases without orphaning installed builds. **Only bump `runtimeVersion` when you ship a NATIVE change** (new/updated native module, native config/plugin, SDK bump) — and cut a fresh build at the new runtime. Bumping it for a JS-only change would needlessly cut existing testers off from OTAs; forgetting to bump it after a native change can push JS that an old binary can't run. (History: it was previously `policy: "appVersion"`, which silently orphaned a tester stuck on a 1.1.7 build from every 1.1.11 OTA.)
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

Cross-screen coordination uses lightweight module-level `Set<Listener>` buses instead of global state: `voiceBus`, `hailBus`, `shareBus`, `shareInbox`, `livePtt`, `commsRead`. Pattern is always `emit(x)` + `subscribe(fn): () => void`. `voiceBus` is how recognized voice intents reach whichever screen handles them (e.g. `map.tsx` subscribes to act on "navigate to …").

### Navigation engine

`src/nav.ts` — uses the **Google Routes API v2** (`computeRoutes`), not the legacy Directions API. Provides `fetchRoutes`, the `useTurnByTurn` step machine, distance/ETA formatters, and TTS announcements (which duck the music player via `applePlayer`). `src/novaGreeting.ts` prepares/plays the Nova voice greeting at route start.

### Voice / Nova

`src/useVoice.ts` records audio (quality scales with convoy proximity tier, see `src/proximityAudio.ts`), sends it to the backend for transcription + intent, and emits onto `voiceBus`. TTS is `expo-speech` / Nova. `VoiceController`, `VoiceTabButton` are the UI entry points.

### Map rendering

`src/ConvoyMapbox.tsx` (`@rnmapbox/maps`) is the map engine on every platform — the 3D drive view, peers, hazards, and the route line all render through it. The legacy `react-native-maps` / `@vis.gl/react-google-maps` engine (`ConvoyMap.tsx` / `ConvoyMap.web.tsx`) was fully retired and those deps removed (RerouteCard's preview now uses a Mapbox static image; the `react-native-maps`/`expo-symbols`/`expo-background-fetch` dep + native Google-Maps-plugin removal is staged for the next native build).

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
- Platform-specific files use the `.ios.ts` / `.web.tsx` suffix convention (e.g. `applePlayer.ios.ts` vs `applePlayer.ts`, `RerouteCard.web.tsx`).
- Many native APIs throw on web — guard with `Platform.OS !== "web"` (push notifications, CarPlay, audio recording all do this).

## Release Discipline

- **Publish each OTA to the branch that matches the INSTALLED build's channel — verify, don't assume.** Run `eas build:list --platform ios` and read the `Channel` of the build testers are on, then `eas update --branch <that-channel>`. The `mapbox-migration` builds (current: build 61, runtime 1.13.2) listen to the **`mapbox-migration`** channel, so their OTAs go to `eas update --branch mapbox-migration` — publishing to `preview` does NOT reach them (this silently ate three updates on 2026-07-05). The historical `preview`/`production` channels both track the `preview` branch; only use `--branch preview` when the target build was actually built on one of those channels.
- **`yarn typecheck` must pass clean before every publish.** This is a required gate — do not publish on a failing or skipped typecheck.
- **Never run `eas submit`** (TestFlight or production) without the maintainer's explicit go-ahead.
- **EAS native builds cost money.** Batch scope before recommending one, and verify `yarn typecheck` passes, the lockfile (`yarn.lock`) is consistent, and references resolve first.
- **OTAs require testers to cold-start the app twice** to pick up the update (first launch fetches it, second launch runs it).
- **iOS and Android must stay on the SAME `runtimeVersion` — bump the runtime, and you MUST cut BOTH platform builds before the next OTA.** OTAs only reach installed builds whose runtime matches *exactly*, and a runtime bump only "takes" for the platform you actually rebuild. So building only one platform at a new runtime silently orphans the other from every subsequent OTA. (2026-07-06: build 62 bumped runtime 1.13.2→1.14.0 but was cut for **iOS only** — Android stayed on build 61/1.13.2 and missed six OTAs until an Android 1.14.0 build caught it up.) Whenever you bump `runtimeVersion`, queue both `eas build --profile mapbox --platform ios` **and** `--platform android` in the same batch. **Verify parity before every OTA:** run `eas build:list --platform ios` AND `eas build:list --platform android`, confirm the latest finished build on EACH is at the current `app.json` runtime; if they differ, the lower platform needs a build, not an OTA.
