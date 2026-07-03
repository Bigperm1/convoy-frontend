# CarPlay native work — Mac session hand-off

You are Claude Code, now running on a **Mac with Xcode** in the Convoy repo. The prior ~71 commits
of work were done on a Windows PC where Xcode couldn't run, so all native iOS work was deferred to
this moment. **Read `CLAUDE.md` (in this same dir) first** for the architecture. The auto-memories
from the Windows sessions do NOT travel with you — this file is your context.

Branch: `mapbox-migration`. Runtime: `1.13.1` (build 60 is live in TestFlight + as an internal APK).
OTAs go to branch `mapbox-migration`.

**Paths:** after `git clone https://github.com/Bigperm1/convoy-frontend.git`, **`cd convoy-frontend/frontend`**
— that's the Expo app dir where `package.json`, `app.json`, `CLAUDE.md`, and THIS file all live. Run
Claude Code + all `eas`/`expo`/`yarn` commands from here; every `src/…`, `plugins/…`, `app.json`,
`patches/…` path below is relative to this app dir. (The clone root above it also holds python backend
tests + docs — not needed for the CarPlay work.)

---

## PRIMARY TASK: iOS-26 CarPlay multitouch (pinch / zoom / pan / rotate)
Goal: raw-touch pinch/zoom/pan on the CarPlay map. This was BLOCKED on Windows because the exact
iOS-26 `CPMapTemplateDelegate` gesture-callback **selector names were unverifiable without the Xcode
SDK headers**. You can now verify them.

**Step 1 — VERIFY THE SELECTORS FIRST (Mac-only, do before writing any patch):**
Open `<CarPlay/CPMapTemplate.h>` from the iOS SDK (Xcode: `⌘⇧O` → `CPMapTemplate.h`). Find the
`CPMapTemplateDelegate` gesture callbacks. `react-native-carplay@2.4.1-beta.0` already wires
`didUpdatePanGestureWithTranslation`. Confirm the ACTUAL iOS-26 method signatures for pinch/zoom/
rotate/pitch before trusting anything — **Apple may expose less than hoped** (CarPlay gates gestures).
Guard native code with `@available(iOS 26.0, *)` + `#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000`.

**Step 2 — patch `react-native-carplay`:** edit `node_modules/react-native-carplay/ios/RNCarPlay.m`
(add to `supportedEvents` + the delegate methods, mirroring the existing pan gesture), wire the JS
event map in `lib/templates/MapTemplate.js` + `.d.ts`, then `npx patch-package react-native-carplay`
to regenerate `patches/react-native-carplay+2.4.1-beta.0.patch`.

**Step 3 — app-side wiring:** ConvoyCarPlay.tsx gesture handlers → `src/carplay/carStore.ts` →
CarMapView.tsx reads them → `cameraRef.setCamera({ zoomLevel / centerCoordinate ... })`. Mirror the
existing button/pan patterns.

**FALLBACK (guaranteed, OTA-able):** `showPanningInterface`/`onPanWithDirection`/`mapButtons` already
exist in 2.4.1-beta.0 (no patch). If the iOS-26 gesture selectors fall through, ship on-screen
zoom/recenter/pan BUTTONS instead — JS-only, works on every head unit.

---

## This is BUILD 61. Bump at cut-time (NOT before):
- app.json: `runtimeVersion` 1.13.1 → **1.13.2** (or 1.14.0); `ios.buildNumber` + `android.versionCode`
  60 → **61** (KEEP EQUAL; autoIncrement is OFF, bump by hand).
- iOS: `eas build -p ios --profile mapbox-ios` (store → then submit to TestFlight ONLY on explicit go)
  OR **local (free): `npx expo prebuild -p ios` → open `ios/*.xcworkspace` in Xcode → build/run.**
  Test CarPlay via Xcode menu **I/O → External Displays → CarPlay** (Simulator).
- Android APK: `eas build -p android --profile mapbox`.
- **Local build needs `RNMAPBOX_DOWNLOAD_TOKEN`** (a Mapbox `sk.` token) in the env/.env before
  prebuild/`pod install`, or the Mapbox pod download fails. It's an EAS secret for cloud builds.
- `yarn install` runs patch-package (postinstall) — both patches (react-native-carplay, apple-music)
  re-apply on a clean install.
- **Dual-runtime OTAs:** until all testers are on build 61, every `eas update` must be published TWICE
  on branch `mapbox-migration` — once at the new runtime AND once at 1.13.0/1.13.1 (temporarily edit
  app.json runtimeVersion, publish, restore). There's no `--runtime` flag.

## This build also DELIVERS (already staged in the tree, BUILD-BOUND — lands on build 61):
- `react-native-maps` + `expo-symbols` + `expo-background-fetch` deps REMOVED + the app.json
  react-native-maps plugin + native Google Maps keys removed (commit 9e9f63d). RerouteCard already
  uses a Mapbox static image (no react-native-maps). → build 61 drops those native modules.
- **REMOVE the green CarPlay debug UILabel now** — the `dbg` UILabel in `plugins/withConvoyCarPlay.js`,
  kept only for build 60's cold-connect verification. Cold-connect reaching `p1` is confirmed on device.

---

## DO NOT TOUCH (load-bearing, hard-won — additive changes ONLY):
- The CarPlay native commit path in `plugins/withConvoyCarPlay.js`: `forceCarCommit` /
  `synchronouslyWaitFor` @objc shim / retry tick / `RCTSurfaceStageIsRunning` crash guard /
  `carPainted` / `clearCarSplash`. This makes the CarPlay 3D map paint + guards the cold-connect crash.
  Only ADD the gesture selectors; don't rewire the commit path.
- The lockstep chase camera (`SelfCarModel` `pushCam` in `src/ConvoyMapbox.tsx`).

## Constraints (whole project):
- NEVER `git add -A`; NEVER stage/commit `frontend/.env` (tracked in a public repo — secret hazard).
  Stage explicit nested paths.
- `yarn typecheck` must pass before every OTA/build.
- NEVER `eas submit` (TestFlight) without the maintainer's explicit go-ahead. EAS **cloud** builds cost
  money — LOCAL Xcode builds are free; prefer local for iteration.
- Commits end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Also worth nailing with live Mapbox tools (couldn't fix blind on Windows):
The nav route line runs SOLID through the car (no gap/vanish) on phone + CarPlay, even though the
`applyCarGapGradient` + `lineTrimOffset` code is logically correct (reviewed multiple times) and
`routeProj` is confirmed non-null during nav — so it's a RENDER issue, not gating. Use the live Mapbox
layer inspector to see why the trim / transparent-gradient isn't producing transparency on-device.
Files: `src/ConvoyMapbox.tsx` (route-sel-cong / navCongGapped / routeTrimEndFrac) and
`src/carplay/CarMapView.tsx` (car-cong-core / carCongGapped).

## Key files:
- CarPlay: `src/carplay/{ConvoyCarPlay.tsx, CarMapView.tsx, carStore.ts}`, `plugins/withConvoyCarPlay.js`
- Map engine: `src/ConvoyMapbox.tsx` (SelfCarModel lockstep + route layers)
- Build config: `app.json`, `app.config.js` (RNMapboxMapsVersion 11.25.0 pin, RNMAPBOX_DOWNLOAD_TOKEN),
  `eas.json` (profiles: `mapbox` = Android APK, `mapbox-ios` = iOS store, both channel `mapbox-migration`),
  `patches/`
