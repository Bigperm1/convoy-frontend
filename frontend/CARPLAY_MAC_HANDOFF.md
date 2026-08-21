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

## ⚠️ SESSION UPDATE 2026-07-03 (Mac): pinch code DONE, but CarPlay crashes on iOS 26
- **Step 1 (verify selectors) = DONE.** The iOS-26 gesture selectors were confirmed against
  `CarPlay/CPMapTemplate.h` in the **iOS 26.5 SDK** and they match the patch exactly:
  `didUpdateZoomGestureWithCenter:scale:velocity:`, `didRotateWithCenter:rotation:velocity:`,
  `pitchWithCenter:` (all `API_AVAILABLE(ios(26.0))`). The raw pinch path is real — the button
  FALLBACK is not needed for the API's sake.
- **Pinch/zoom feature = code-complete & builds clean** (native patch + carStore + ConvoyCarPlay +
  CarMapView all present; `yarn typecheck` passes; local Xcode build succeeds and runs on the
  iOS 26.5 simulator).
- **iOS-26 Simulator CarPlay crash (RESOLVED as simulator-only):** In the **iOS 26.5 Simulator**,
  opening Convoy CarPlay aborts `CarPlayTemplateUIHost` in
  `-[CPSMapTemplateViewController _updateShareButtonVisibility]` (iOS-26.1 destination-sharing;
  unrecognized selector `vehicleSupportsDestinationSharing`). **Confirmed 2026-07-03 to be an Apple
  Simulator bug, NOT a real-world issue:** build 60 on a real **iPhone (iOS 26.6)** over wireless
  CarPlay opened the map fine, no crash. So CarPlay is OK on real iOS-26 cars; the crash only blocks
  Simulator-based CarPlay testing on iOS 26.
- **Consequence for pinch:** live-test pinch on a **real device** (build 61 + a **touchscreen** head
  unit) — NOT in the Simulator (CarPlay won't open there on iOS 26). Code is done & SDK-verified.
- **Full write-up + real-device result + reports + crash .ips:** `docs/carplay-ios26-crash/`
  (read `README.md` first).
- Local-build gotcha found this session: CocoaPods aborts unless `LANG=en_US.UTF-8` (and
  `LC_ALL`) are exported before `expo run:ios` / `pod install`.
- **CarPlay simulator now WORKS — use the iOS 18.6 runtime.** The iOS-26.x sim crash is Apple's
  iOS-26.1 destination-sharing bug; the **iOS 18.6 simulator opens Convoy CarPlay clean** (verified
  2026-07-03 — "Convoy iOS18 CarPlay" device, map renders, no crash). Install older runtimes with
  `xcodebuild -downloadPlatform iOS -buildVersion 18.6`. Use iOS 18.6 for CarPlay dev/test, iOS 26.5
  for iOS-26-only work, real device for the pinch gesture. (On the sim's secondary CarPlay display the
  live GL map may demote to the 2D static fallback — by design; full 3D works on real devices.)

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

## Git auth (for pushing your build-61 work back up):
The repo is **PUBLIC**, so `git clone` needs NO token. But **pushing needs a valid
GitHub PAT** (classic, `repo` scope — from github.com/settings/tokens/new). Ask the
maintainer for one; do NOT hardcode any token in a committed file (public repo).
To avoid a non-interactive hang, push with the token in the remote URL + credential
helper disabled: `git remote set-url origin https://<TOKEN>@github.com/Bigperm1/convoy-frontend.git`
then `git -c credential.helper= push origin mapbox-migration`. (The prior token expired
2026-07 — that was the whole reason pushes hung on Windows; the maintainer knows to issue a fresh one.)

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
