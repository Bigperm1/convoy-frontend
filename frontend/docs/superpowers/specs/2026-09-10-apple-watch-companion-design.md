# Apple Watch companion — design (build 77)

**Status:** approved in chat by Jeff 2026-09-10 ("go"). Scope = **Full Tier 1, companion only, phone-driven mirror**
(approach A). Native — ships in the build-77 cut (both platforms at 77, runtime bump). Nothing here is OTA-able except
the TypeScript feed/threshold code, which is OTA-tunable once the binary carries the module.

Every claim below is VERIFIED against this tree on 2026-09-10 unless marked HYPOTHESIS; the two spikes exist to turn
the hypotheses into receipts before feature code is written.

## 1 · Goal

A paired Apple Watch, during a drive already running on the phone (phone or CarPlay), shows the next turn, taps the
wrist with Apple's directional turn haptics, carries a crew-live complication, and can send push-to-talk clips. The watch
does nothing without the phone (Jeff: companion only). Out of scope for 77: hearing PTT clips on the wrist; any
navigation without the phone.

## 2 · What already exists (receipts)

- Turn state: `useTurnByTurn` (`src/nav.ts`) → `{stepIndex, distanceToManeuverM, etaSeconds}`; carStore carries
  `navigating / instruction / distanceToTurnM / maneuverIcon` (`src/carplay/carStore.ts:59-66,119,225`); the turn SIDE
  is Mapbox `maneuver.modifier` (`src/nav.ts:170 mapboxManeuverKey`). The locked-phone path (`NAV_TASK`,
  `src/navNotification.ts:672`) keeps this alive via location callbacks, not JS timers (memory
  `js-timers-frozen-on-locked-carplay`).
- PTT: `Audio.Recording` → base64 → `POST /api/ptt {channel, audio_b64, duration_ms}` + `floor_acquire/release` over the
  socket (`src/pttChannel.ts:182,282,105-106`). Recording params: `getPttRecordingOptions(tier)` (`src/proximityAudio.ts`).
- Presence: `useConvoyPresence` peers array (`src/convoyPresence.ts:92`) → crew-live count.
- Native pattern: `modules/hairpin-system` (Swift Expo `Module`, `requireOptionalNativeModule` accessor,
  `setSharedDefaults` App Group write for the widget). Target pattern: `targets/widget/expo-target.config.js`.
- Toolchain: `@bacons/apple-targets` 4.0.7 supports `watch` (app with companion) and `watch-widget` (complication)
  (`README.md:325-326`); its README states these types are not all tested. Watch app config gets
  `INFOPLIST_KEY_WKCompanionAppBundleIdentifier` from the main app and `SDKROOT: watchos`
  (`build/configuration-list.js:285-299`).
- SDK (watchOS 26.5, Xcode 26.6): `WKHapticType.navigationLeftTurn / navigationRightTurn / navigationGenericManeuver`
  (watchOS 7+, `WKInterfaceDevice.h:27-29`); `WKExtendedRuntimeSession.h` and `HKWorkoutSession.h` present;
  `AVAudioRecorder.h` present in AVFAudio; `WatchConnectivity.framework` present on both the watchOS and iOS SDKs.
  Simulators: watchOS 26.5 and 27.0 runtimes installed.
- Jeff has his own Apple Watch for the wrist spike.

## 3 · Components

| Unit | Kind | Does | Depends on |
|---|---|---|---|
| `targets/watch` (`HairpinWatch`) | watchOS app, SwiftUI | Turn card (glyph · street · distance countdown · ETA), crew count, hold-to-talk button; plays haptics on command; keeps a local store for the complication | WatchConnectivity, WatchKit haptics, AVFAudio |
| `targets/watch-widget` | watch complication | circular / rectangular / inline crew-live count from the watch app's store | the watch app's UserDefaults |
| `modules/hairpin-watch` | local Expo module (Swift, iOS) | owns the phone `WCSession`: `updateContext(json)`, `sendMessage(json)`, `getState()` (one call folding supported/paired/appInstalled/reachable/activation — there is no separate `isPaired()`/`isReachable()`); emits `onWatchFile` (PTT clip path), `onWatchState` and `onWatchSendError` events to JS | WatchConnectivity |
| `src/watchFeed.ts` | TS, pure core + thin RN shell | subscribes to carStore/tbt/presence; builds the context payload; throttles (on change, ≤2 Hz); decides taps (`prepare`/`now`, left/right/generic) via `src/watchTaps.ts`; posts the Tier-0 notification fallback | carStore, nav, presence, `hairpin-watch`, expo-notifications |
| `src/watchTaps.ts` | TS, pure | the ONE tap-threshold rule (speed-scaled lead + at-maneuver), given `{distM, speedMs, side}` and the last-tapped step → `null | 'prepare' | 'now'` | nothing |
| `src/watchPtt.ts` | TS | receives a watch clip file event → base64 → the existing `/api/ptt` POST + floor messages | `pttChannel.ts` helpers |

Bundle ids: watch app `com.sw0rdfisch.convoy.watchkitapp`, complication `com.sw0rdfisch.convoy.watchkitapp.widget`.
watchOS deployment floor: 10.0 (HYPOTHESIS until Spike 1 compiles; apple-targets' default is used if 10.0 fights it).

## 4 · Data flow

1. Drive starts on the phone (map.tsx or the cold/CarPlay path). `watchFeed` starts when `HairpinWatch.getState().paired`.
2. On every carStore/tbt change: payload `{nav: {on, glyph, street, distM, side, eta, stepIdx}, crew: {live}, at}` →
   `updateApplicationContext` (always; the watch gets the latest on its next run) and `sendMessage` when
   `getState().reachable` (live card).
3. `watchTaps` decides `prepare`/`now` per step; `watchFeed` sends `{tap}` via `sendMessage`. If not reachable, it
   schedules an immediate local notification (glyph + street + distance; category `turn`) — iOS mirrors it to the wrist
   with a standard tap. Suppressed when the phone screen is on (the in-app banner already shows). Respects the existing
   notification-permission gate; never prompts from this path.
4. Watch: `WCSessionDelegate` writes the store, redraws the card, plays the haptic on `{tap}`, reloads complication
   timelines on `crew.live` change.
5. PTT: hold → `AVAudioRecorder` (fixed AAC 22.05 kHz mono 64 kbps — the "mid" tier's shape; the wrist does not know
   the proximity tier, so it never varies) → release → `transferFile` → phone module → `onWatchFile` event →
   `watchPtt` uploads via the existing POST. The floor is acquired on press-down (`sendMessage {ptt:'down'}`) against
   the channel active AT THAT MOMENT, and **released on press-up (mirrors the phone's `talk.tsx`), the upload
   follows** — another driver may take the floor while the clip is still uploading; that is the phone's semantics
   too. A press-up that never arrives (link dropped, watch app killed) is covered by a 30 s watchdog.
   Watch mic permission = the watch's own prompt on first press (documented exception to `permissionGate`).

## 5 · Haptic keep-alive — the spike, not a decision

Directional taps need the watch app reachable; a backgrounded watch app is not. Candidates, each behind a receipt:
(a) `WKExtendedRuntimeSession` started when a drive begins — HYPOTHESIS that its session types/duration fit a drive;
(b) `HKWorkoutSession` (the komoot pattern) — review risk for a driving app;
(c) fallback only — Tier-0 notifications, standard tap.
Spike 2 = a local dev-signed build on Jeff's phone + watch, three drives, read `watch-tap sent= reachable= via=msg|notif`
rows. The winner ships; the others stay out of the code.

**Spike 2, Step 1 result (2026-09-10, VERIFIED from Apple's "Using extended runtime sessions", fetched via
developer.apple.com/tutorials/data/documentation/watchkit/using-extended-runtime-sessions.json):** the session
types are Self care (frontmost, 10 min), Mindfulness (frontmost, 1 h), Physical therapy (background, 1 h) and Smart
alarm (background, 30 min, schedulable); "Select a session type based on the app's intended use—not based on the
features that the session provides"; "Each app can only support one type of extended runtime session". A driving
companion is none of these — **candidate (a) is out; no `WKExtendedRuntimeSession` code is written.** The same page:
"With background sessions, your app continues to run in the background, but the sessions can only monitor workouts,
track the user's location, or play audio files" — so the legitimate ways to stay reachable are (b) a workout session
(HealthKit entitlement, review risk for "driving") or (d) the watch's own **location** background mode, which is
legitimate only if the watch app actually tracks the drive. Both need Jeff's go. Spike 2 on the wrist therefore
measures the DEFAULT first (no code: how many `watch-tap` rows go `via=msg` with the phone in the mount and the
watch app merely frontmost), and only then, with Jeff's decision, one of (b)/(d). Until measured, the shipped
behaviour is (c): directional taps while the watch app is reachable, the mirrored local notification otherwise.

## 6 · Error handling

- Not paired / no watch app installed → `watchFeed` never starts; zero cost.
- `sendMessage` errors → fall through to the notification path for taps; context updates never throw (queued by iOS).
- Watch app cold → first `applicationContext` renders the card; a stale payload (`at` older than 30 s) shows "Waiting
  for phone".
- PTT transfer failure → a failed transfer shows "Not sent" on the wrist via `pttStatus` (set from
  `session(_:didFinish:error:)`, the only place the failure is ever visible — the phone never saw the clip); the
  phone side logs `watch-ptt fail=` for the clips that did arrive but failed to upload.
- Android / web / older binaries → every entry point is a no-op (`requireOptionalNativeModule`).

## 7 · Receipts & gates

- Breadcrumbs (bounded, `logEventReliable`): `watch-ctx paired= reachable= app=` once per change (≤ 20 rows);
  `watch-tap step= kind= side= via=msg|notif|suppressed|notif-after-fail ok=`; `watch-ptt ms= bytes= ok= fail=`.
- Node gates: `tools/sim-qc/watch_taps_test.mts` (thresholds by speed, one tap per kind per step, left/right/generic
  mapping) and `tools/sim-qc/watch_feed_test.mts` (payload shape, on-change throttle, stale rule).
- trap-check rule: `watch-haptic-math-in-swift` — no distance/speed comparison in `targets/watch/**/*.swift`, `targets/watch-widget/**/*.swift` or `modules/hairpin-watch/ios/**/*.swift`.
- Sim: paired iPhone 17 Pro + watchOS 26.5 sims with the existing `tools/sim-qc/drive.sh` route replay.

## 8 · Sequencing

1. **Spike 1 (sim, throwaway):** `targets/watch` "Hello" + `targets/watch-widget` → `expo prebuild --clean` → compile →
   embed → launches on the paired sims. Output = "apple-targets watch works / needs X".

   **2026-09-10 result: works as-is**, with two unrelated environment gotchas (neither is an `@bacons/apple-targets` bug):
   - `npx expo prebuild --clean --platform ios` — the prebuild phase itself succeeded clean (`✔ Finished prebuild`);
     the immediately-following `pod install` sub-step failed with `Encoding::CompatibilityError` from
     `Ruby 4.0.5 unicode_normalize` because this shell's `LANG`/`LC_ALL` were empty (CocoaPods 1.16.2 requires
     UTF-8). Fix: `cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install --repo-update` — succeeded, "129
     dependencies from the Podfile and 144 total pods installed."
   - `grep -c "HairpinWatch" ios/Hairpin.xcodeproj/project.pbxproj` → `32` (>0); `WATCHOS_DEPLOYMENT_TARGET = 10.0`
     and `INFOPLIST_KEY_WKCompanionAppBundleIdentifier = com.sw0rdfisch.convoy` both present — apple-targets wired
     both new targets into the generated Xcode project correctly.
   - `xcodebuild -scheme HairpinWatch -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'` →
     `** BUILD SUCCEEDED **`. Side note: this scheme's build graph pulls in and compiles the *entire* phone app
     (Mapbox, RNSVG, etc. for `iphonesimulator`, not just watchOS) — a scoping quirk that makes this build far
     slower than a watch-only build would be, not a failure.
   - `xcodebuild -scheme Hairpin -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max'` →
     `** BUILD SUCCEEDED **`; `ls Hairpin.app/Watch` → `HairpinWatch.app` (embedded), and
     `HairpinWatch.app/PlugIns` → `HairpinWatchWidget.appex` (the complication extension is embedded inside the
     watch app, as expected).
   - Launch on the paired sims: the brief's exact sequence (`simctl install` on the **phone** sim only, then
     `simctl launch` on the **watch** sim) failed first try —
     `FBSOpenApplicationServiceErrorDomain code=4: Simulator device failed to launch`. Installing the phone app
     alone did not auto-propagate the WatchKit companion onto the already-booted, already-paired watch simulator.
     Fix: `xcrun simctl install D26BBDBE-3DD0-4252-8D76-DDA0AF1F632D ".../Hairpin.app/Watch/HairpinWatch.app"`
     (install the watch bundle directly on the watch sim's UDID), then `simctl launch` succeeded (returned a PID)
     and the screenshot shows "Hairpin" centered on the watch face with the sim clock (8:30) in the corner.
   - **Net:** `@bacons/apple-targets` 4.0.7 needs no patch or workaround of its own — prebuild, compile, and the
     `Embed Watch Content` phase all work out of the box. The two fixes above (`LANG` for pod install, direct
     watch-UDID install for first launch) are one-time / per-session environment steps, not code changes.
2. **Spike 2 (Jeff's wrist, throwaway strategies):** module + card + taps behind the three keep-alive options.
3. Feature work per this spec; gates green; Codex review.
4. Build 77 cut with the rest of the list (`build-77-backlog`): runtime bump, both platforms at 77, Jeff's paid go.
