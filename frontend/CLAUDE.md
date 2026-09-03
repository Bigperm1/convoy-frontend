<!-- ═════════ RULE #1 — READ THIS BEFORE ANYTHING ELSE ═════════ -->
# 🛑 NO GUESSING. NO THEORIZING. NO HALLUCINATING.

**Every claim is VERIFIED, or the word HYPOTHESIS is said out loud. No exceptions.**

- **VERIFIED** = I ran the query · read the file · measured it · asked Jeff — and I can show the receipt.
- Reading code and reasoning about it is **NOT** verification. Neither is *"it would explain the symptom."*
- **Never** state a root cause, a fix, or a conclusion I have not tested. Not even a likely-sounding one.
- **Check the instrumentation that ALREADY EXISTS** before inventing an explanation. It usually answers it.
- Separate cleanly: *what the data shows* vs *what I don't know*. Put the unknowns in writing.
- **"I don't know — here is the ONE check that would settle it"** is a GOOD answer.
  A confident wrong answer costs a day and burns trust.

> Jeff, 2026-08-21, in caps: **"ABSOLUTLEY STOP GUESSING, NO THEORYIZING, NO HALLUCENATIONS."**
> Trigger: I declared `ADVANCE_THRESHOLD_M = 25` the root cause of a stuck step index — from a code read alone,
> presented as a finding. The `turn=` breadcrumb, **already in the logs**, refuted it in a single query.
> The instrumentation existed. I guessed instead of reading it. Then I did it again with the timezone.
<!-- ═════════ END RULE #1 ═════════ -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**➜ Read `RULES.md` first** (how to work — Rule #1 and every standing rule), **then the newest
`HANDOFF-<date>.md`** (current state — today `HANDOFF-2026-09-02.md`), **then `ROADMAP.md`**
(the OTA position, what ships next, open issues ranked).

Then, as needed:
- `SCAN-PIPELINE.md` — **THE photo → car pipeline**, now FULLY AUTOMATIC (Supabase `scan-worker`
  edge function on a 15 s pg_cron; the by-hand Tripo CLI recipe is the documented fallback).
  Measured recipe, traps, QC gates. Deploy runbook: `supabase/SCAN-WORKER-DEPLOY.md`. `HANDOFF-3D.md` is that work's historical log — lessons only.
- `HANDOFF-48H-2026-08-16.md` — the 08-14 → 08-16 window (heat, the location regression).
- `HANDOFF.md` — the long chronological log. **⛔ Its header state is STALE (build 70).**
  Read it for the root-cause write-ups and traps, never for current state.
- `CARPLAY.md` — the locked CarPlay/Android Auto spec.
- `DESIGN.md` — the locked tier visual language: Gold = Ultra Premium, Silver = Premium,
  the Hairpin-H locks, and where each may appear.
- `WHY-IT-HEATS.md` — thermal analysis.

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
- `app/(app)/*` — the authenticated app, a `Tabs` layout. **`app/(app)/map.tsx` is the center of gravity (~5,900 lines as of 2026-08-30)** — it owns location, the WebSocket, presence, navigation state, hazards, and feeds the CarPlay surface. Most map/nav feature work happens here or in the `src/` modules it composes.
  > ⚠ **LINE NUMBERS IN THESE DOCS DRIFT — GREP, DON'T TRUST.** This file said "~3000 lines"
  > for long enough that the real figure had nearly doubled. `CARPLAY.md` rule 1 cited `:2980`
  > for a render early-return that had moved ~1,200 lines, and a comment inside `map.tsx`
  > itself pointed at `:3023` for that same line. All three corrected 2026-08-30 — and the
  > correction itself shifted the target three more lines, which is the whole argument.
  > **Locate anything in this file by searching for its comment text, never by line number.**

`src/auth.tsx` exposes `AuthProvider` / `useAuth`. `user` is `undefined` while loading, `null` when signed out — preserve this three-state contract. Token lives in AsyncStorage (`src/api.ts`) and is auto-attached as a Bearer header by the axios interceptor.

### Two backends

1. **Custom backend** (`src/api.ts`) — axios client at `BACKEND_URL` (Render). Auth, profiles, hazards REST fallback, push-token registration, voice transcription/intent, and a WebSocket (`wsUrl(token)`) for live convoy state. `formatErr()` is the standard error-to-string helper (note its special-case for cold-start timeouts — the Render backend sleeps).
2. **Supabase** (`src/supabase.ts`) — Realtime channels for live peer presence/avatars (`src/convoyPresence.ts`) and hazard broadcast. The anon key is RLS-protected and intentionally shipped in the client.

### Env vars & the hardcoded-fallback pattern (important)

`EXPO_PUBLIC_*` vars come from `.env` (local) and `eas.json` `env` blocks (builds). EAS has historically failed to inject these at bundle time, silently killing search/routes/presence. So `src/api.ts` and `src/supabase.ts` deliberately keep **hardcoded production fallbacks** (`PROD_BACKEND_URL`, `PROD_MAPS_KEY`, `FALLBACK_SUPABASE_*`) and read `process.env.X || FALLBACK`. This redundancy is intentional — read the long comments before "cleaning it up." Supabase client creation gates on `Platform`, **not** `typeof window` (which is undefined on Hermes and would disable presence on device).

### Permissions (staggered, never at login)

`src/permissionGate.ts` is the ONLY place that should raise an OS permission prompt. It
SERIALIZES prompts — one dialog at a time with a ~900ms gap — because correctly-placed
prompts can still collide (a screen mounts, a tab switch lands, iOS stacks the sheets and
the user reflexively denies). Only the PROMPT is queued; reading an already-decided status
never is.

Placement: **location → Map**, **mic → Comms**, **notifications → Comms** (awaited after the
mic sheet), **Apple Music → Music** (user-initiated). The app shell prompts for NOTHING.
`src/pushRegistration.ts` splits the two halves: `reportDevice()` never prompts and runs at
login so the admin roster stays complete; `registerPushToken()` only fetches a token when
permission is already granted.

Rule: gate on `status === 'undetermined'`. On Android, Expo tracks "have we asked?" in app
storage, so a revoked-but-previously-asked permission reports `denied` and must NOT be
re-prompted.

### Settings defaults

`DEFAULT_SETTINGS` in `src/settings.ts` is FIRST-LAUNCH ONLY — existing installs keep their
stored values (load does `{...DEFAULT_SETTINGS, ...parsed}`). To change behaviour for
EXISTING testers you need a one-time migration flag next to `weatherOnMigrated` /
`novaQuietMigrated` / `baselineMigrated`; follow that pattern and never silently flip a
choice the user made. Per-source audio levels are the `STOCK_BY_KEY` table (voice 80 /
alerts 60 / comms 80 / transmissions 80) — those are what an untuned install plays at and
what the Audio screen's sliders seed from.

### Event buses (pub/sub)

Cross-screen coordination uses lightweight module-level `Set<Listener>` buses instead of global state: `voiceBus`, `hailBus`, `shareBus`, `shareInbox`, `livePtt`, `commsRead`. Pattern is always `emit(x)` + `subscribe(fn): () => void`. `voiceBus` is how recognized voice intents reach whichever screen handles them (e.g. `map.tsx` subscribes to act on "navigate to …").

### Navigation engine

`src/nav.ts` — uses the **Mapbox Directions API** (`src/mapboxDirections.ts`): `fetchMapboxRoutes` for alternatives, `fetchMapboxRouteVia` for stops + the AI route's habitual-path replay, `refreshMapboxRoute` for live ETA. ⚠ **This line used to say "Google Routes API v2 (computeRoutes)"** — stale since the 2026-06-14 move to Mapbox (`fcaebc8`) and repeated back to Jeff as fact on 2026-08-27. **There is no Google routing call left in the app.** Google survives only for Places autocomplete, voice place/geocode lookups, one country lookup for units, and Sign in with Google. Provides `fetchRoutes`, the `useTurnByTurn` step machine, distance/ETA formatters, and TTS announcements (which duck the music player via `applePlayer`). `src/novaGreeting.ts` prepares/plays the Nova voice greeting at route start.

### Voice / Nova

`src/useVoice.ts` records audio (quality scales with convoy proximity tier, see `src/proximityAudio.ts`), sends it to the backend for transcription + intent, and emits onto `voiceBus`. TTS is `expo-speech` / Nova. `VoiceController`, `VoiceTabButton` are the UI entry points.

### Map rendering

`src/ConvoyMapbox.tsx` (`@rnmapbox/maps`) is the map engine on every platform — the 3D drive view, peers, hazards, and the route line all render through it. The legacy `react-native-maps` / `@vis.gl/react-google-maps` engine (`ConvoyMap.tsx` / `ConvoyMap.web.tsx`) was fully retired and those deps removed (RerouteCard's preview now uses a Mapbox static image. The `react-native-maps` / `expo-symbols` / `expo-background-fetch` deps and the native Google-Maps plugin are **GONE** — removed in `9e9f63d` 2026-06-30 and already inside the build-74 binary; verified 2026-09-02: zero hits in `package.json`, `yarn.lock`, `node_modules` and `app.json`. The only remaining source hits are comments.)

**⛔ Per-tick state never goes in a layer `style`/`filter` (2026-09-01).** `@rnmapbox` has no
style diff: any CONTENT change to a layer's `style` prop is a full main-thread
read-modify-write of that layer (`RNMBXLayer.reactStyle didSet → StyleManager.updateLayer →
getStyleLayerProperties`, serialised through CoreFoundation strings, synchronous against the
render thread). The route ribbon used to push `lineTrimOffset` + a re-baked congestion
`lineGradient` that way at 12 Hz on three layers per surface — that is the exact main-thread
stack in the `0x8BADF00D` watchdog kills on Jeff's 9 am drive (five relaunches in four minutes)
and the mechanism behind "Show map froze the phone and CarPlay" (one main thread, two
surfaces). Anything that moves per tick lives in the **source** instead: `src/routeRibbon.ts`
cuts the ribbon geometry at the car and carries colour/alpha per feature, so the ribbon layers
are static on both surfaces — and the self-car marker's heading rides its source feature
(`hdg`/`rot` → `iconRotate`/`modelRotation: ['get', …]`) for the same reason. Review of the
fix found the marker was a second per-frame path with TWO synchronous RMWs per change
(the `sourceID`/`filter` setters fire `optionsChanged` inside `RCTMountingManager.updateProps`). `heatProbe`'s `main-gap` breadcrumb now fires the moment a
main-thread stall that RECOVERS ends; a stall the watchdog kills leaves no JS row at all —
ask for the `.ips` from Settings → Privacy & Security → Analytics Data.

**⛔ A `['zoom']` curve in `modelScale` is evaluated at the TILE's integer zoom (2026-09-03).** Mapbox
re-evaluates model-scale/rotation/translation per feature only when the integer zoom changes
(`mapbox-gl-js/3d-style/data/bucket/model_bucket.ts`), so between whole zooms a 3D model's screen size
drifts ∝ 2^(z−⌊z⌋) and pops 2× at each crossing — Jeff's 09-03 CarPlay video, measured frame by frame.
The self car's size therefore rides the source feature per tick (`scl` ← `modelScaleForPoints()`), like
its heading. Never size a model with a zoom expression again.

### CarPlay / Android Auto

`src/carplay/ConvoyCarPlay.tsx` is a **presentation surface only** — no nav engine or voice of its own. It mirrors the live route/peers from `map.tsx` into `carStore.ts`. iOS gets Map/Comms/Music tabs; Android Auto is navigation-only by platform rule. `.web.tsx` stubs keep `react-native-carplay` (which runs native side effects at import) out of the web bundle; it's also loaded lazily and only when the native module exists. Discoverability requires the config plugins below.

### Config plugins (`plugins/`)

Custom Expo config plugins run at prebuild: `withConvoyAndroidAuto.js` (injects the `com.google.android.gms.car.application` meta-data + `automotive_app_desc.xml` so Android Auto lists the app) and `withConvoyCarPlay.js`. Registered in `app.json` `plugins`.

### Patches (`patches/`, patch-package)

**⚠ ALWAYS regenerate with `--exclude 'android/build/'`:**
```bash
npx patch-package react-native-carplay --exclude 'android/build/'
```
A stale Gradle `android/build/` tree inside `node_modules` (left by any local Android build)
otherwise gets swept in, producing a 382 KB patch of 342 files — 651 `.dex`/`.bin` artifacts —
that **silently DROPS every real diff, including the whole Android Auto port**. Deleting the
directory is NOT enough: patch-package's pristine reference still carries it. After
regenerating, always verify the file list is unchanged:
`grep -ac '^diff --git' patches/<name>.patch` (2026-07-24: this nearly destroyed the CarPlay patch).

**⚠ `patch-package <package-name>` REGENERATES the patch — it does NOT apply it.**
Only the bare `npx patch-package` (no arguments) applies. Passing a name rewrites
`patches/<name>.patch` from whatever is in `node_modules` right now, so running it against an
UNPATCHED tree silently overwrites a good patch with a smaller one. (2026-08-26: reaching for
`npx patch-package @lomray/react-native-apple-music --reverse` to undo a failed apply regenerated
the patch instead, dropping `CatalogService.swift` — 7 diffs became 6 and the Apple Music playlist
search vanished. Same catastrophe as the `android/build/` trap, different mechanism.)

**To check whether a patch is applied, never re-run patch-package — ask git:**
```bash
git apply --check --reverse patches/<name>.patch   # exit 0 = fully applied. Writes nothing.
```
**To recover a patch you clobbered:** `git checkout -- patches/`, delete the package from
`node_modules`, then `yarn install --check-files` (a plain `yarn install` will NOT re-fetch a
deleted package — it considers the lockfile satisfied), and re-verify with the command above.

Native deps are patched at install time via `patch-package` (postinstall hook): `react-native-carplay` (RN 0.81 / New Arch null-safety fixes — see recent commits) and `@lomray/react-native-apple-music`. If you change a patched package, regenerate with `npx patch-package <name>`.

## Conventions

- TypeScript `strict`. Path aliases: `@/*` → repo root, `~/*` → `src/*` (though most code uses relative imports).
- Dark UI only (`userInterfaceStyle: "dark"`). Shared colors in `src/theme.ts` (`COLORS`); frosted panels via `src/Glass.tsx` (`expo-blur`).
- **Tier colours are NOT in `theme.ts`** — Gold (Ultra Premium) and Silver (Premium) live in
  `src/tierTheme.ts`, spec in `DESIGN.md`. Green is for untiered surfaces only.
- User preferences persist through `src/settings.ts` (`useSettings` / `getSettings` / `updateSettings`, AsyncStorage key `convoy.settings.v3` — bump the key version on breaking shape changes).
- Platform-specific files use the `.ios.ts` / `.web.tsx` suffix convention (e.g. `applePlayer.ios.ts` vs `applePlayer.ts`, `RerouteCard.web.tsx`).
- Many native APIs throw on web — guard with `Platform.OS !== "web"` (push notifications, CarPlay, audio recording all do this).

## Release Discipline

- **Publish each OTA to the branch that matches the INSTALLED build's channel — verify, don't assume.** Run `eas build:list --platform ios` and read the `Channel` of the build testers are on, then `eas update --branch <that-channel>`. The `mapbox-migration` builds (current: **build 75, runtime 1.27.0**, both platforms, cut 2026-09-02 — but read the `Channel` field off `eas build:list` rather than trusting this number) listen to the **`mapbox-migration`** channel, so their OTAs go to `eas update --branch mapbox-migration` — publishing to `preview` does NOT reach them (this silently ate three updates on 2026-07-05). The historical `preview`/`production` channels both track the `preview` branch; only use `--branch preview` when the target build was actually built on one of those channels.
- 🛑 **NEVER a bare `eas update`.** A bare publish inlines an EMPTY `EXPO_PUBLIC_OPENWEATHER_KEY`
  (`PROD_OPENWEATHER_KEY` is `""` in `src/api.ts`; the real key lives only in the EAS environment),
  which killed weather on every surface for ~20 h / 13 OTAs on 2026-08-30. Publish through
  `npx eas-cli env:exec preview "npx eas-cli update --branch mapbox-migration --clear-cache -m '…' --non-interactive"`
  and then PROVE it: `python3 tools/ota/verify-bundle-key.py <group> 1.26.0` → `KEY_PRESENT=1` on BOTH platforms.
- **`python3 scripts/trap-check.py` must pass before every publish (2026-09-03).** It greps for the
  signatures of bugs already root-caused (zoom-curve `modelScale`, per-tick layer-style writes,
  `Constants.nativeBuildVersion`, a ribbon cut from a foreign polyline fraction, bare `eas update`).
  Add a rule the day a root cause closes. Field behaviour is gated by `tools/sim-qc/` (see its README).
- **`yarn typecheck` must pass clean before every publish.** This is a required gate — do not publish on a failing or skipped typecheck.
  ⚠ `supabase/` is Deno and is EXCLUDED in `tsconfig.json` — check it with `deno task check` inside
  `supabase/functions/scan-worker/`, never with `tsc` (its sources put 111 errors into the gate on 2026-09-02).
- **Never run `eas submit`** (TestFlight or production) without the maintainer's explicit go-ahead.
- **Google Play's target-API floor moves every Aug 31 — and `app.json` PINS ours.** `expo-build-properties` → `android.targetSdkVersion`/`compileSdkVersion` (36 since 2026-09-02; Play required API 36 for updates from 2026-08-31 and rejected build 75 at 35). Check the pin against https://support.google.com/googleplay/android-developer/answer/11926878 before every Android cut; a rejected upload is a wasted paid build.
- **EAS native builds cost money.** Batch scope before recommending one, and verify `yarn typecheck` passes, the lockfile (`yarn.lock`) is consistent, and references resolve first.
- **The RED PILL is the one and only OTA pickup instruction.** Tell testers: open the app, wait a few seconds on the map, tap the red **"Update ready — tap to install"** pill under the search bar. That's `src/UpdateReadyPill.tsx` — it watches `isUpdatePending` and the tap calls `reloadAsync()`, so the new JS runs immediately. Do **NOT** say "Settings → Software Update" (that row was REMOVED, and it lied anyway: `checkForUpdateAsync` compares the server to what's DOWNLOADED, not what's RUNNING) and do **NOT** say "cold-start twice" — that's the old dance the pill replaced. Jeff's call, 2026-07-25: two competing instructions confused testers, so there is exactly one. Only if the pill never appears is the device stranded on the embedded bundle (`/ota-rescue`).
- **iOS and Android must carry the SAME BUILD NUMBER, not just the same runtime (Jeff, 2026-09-03).** Build 75 shipped as iOS 75 + Android 76 because Play rejected the first Android AAB and only Android was re-cut; testers then read "v75" on an Android that was really 76 and nobody could tell which binary they had. From now on: if either platform is re-cut for any reason, the other is re-cut at the same number — the next cut is **77 on BOTH** (never 76-iOS / 77-Android). `buildNumber` and `versionCode` move together in `app.json`, always.
- **iOS and Android must stay on the SAME `runtimeVersion` — bump the runtime, and you MUST cut BOTH platform builds before the next OTA.** OTAs only reach installed builds whose runtime matches *exactly*, and a runtime bump only "takes" for the platform you actually rebuild. So building only one platform at a new runtime silently orphans the other from every subsequent OTA. (2026-07-06: build 62 bumped runtime 1.13.2→1.14.0 but was cut for **iOS only** — Android stayed on build 61/1.13.2 and missed six OTAs until an Android 1.14.0 build caught it up.) Whenever you bump `runtimeVersion`, queue both `eas build --profile mapbox --platform ios` **and** `--platform android` in the same batch. **Verify parity before every OTA:** run `eas build:list --platform ios` AND `eas build:list --platform android`, confirm the latest finished build on EACH is at the current `app.json` runtime; if they differ, the lower platform needs a build, not an OTA.
