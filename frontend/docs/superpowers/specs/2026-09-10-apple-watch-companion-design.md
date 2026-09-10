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
| `modules/hairpin-watch` | local Expo module (Swift, iOS) | owns the phone `WCSession`: `updateContext(json)`, `sendMessage(json)`, `isReachable()`, `isPaired()`; emits `watchFile` (PTT clip path) and `watchState` events to JS | WatchConnectivity |
| `src/watchFeed.ts` | TS, pure core + thin RN shell | subscribes to carStore/tbt/presence; builds the context payload; throttles (on change, ≤2 Hz); decides taps (`prepare`/`now`, left/right/generic) via `src/watchTaps.ts`; posts the Tier-0 notification fallback | carStore, nav, presence, `hairpin-watch`, expo-notifications |
| `src/watchTaps.ts` | TS, pure | the ONE tap-threshold rule (speed-scaled lead + at-maneuver), given `{distM, speedMs, side}` and the last-tapped step → `null | 'prepare' | 'now'` | nothing |
| `src/watchPtt.ts` | TS | receives a watch clip file event → base64 → the existing `/api/ptt` POST + floor messages | `pttChannel.ts` helpers |

Bundle ids: watch app `com.sw0rdfisch.convoy.watchkitapp`, complication `com.sw0rdfisch.convoy.watchkitapp.widget`.
watchOS deployment floor: 10.0 (HYPOTHESIS until Spike 1 compiles; apple-targets' default is used if 10.0 fights it).

## 4 · Data flow

1. Drive starts on the phone (map.tsx or the cold/CarPlay path). `watchFeed` starts when `HairpinWatch.isPaired()`.
2. On every carStore/tbt change: payload `{nav: {on, glyph, street, distM, side, eta, stepIdx}, crew: {live}, at}` →
   `updateApplicationContext` (always; the watch gets the latest on its next run) and `sendMessage` when
   `isReachable()` (live card).
3. `watchTaps` decides `prepare`/`now` per step; `watchFeed` sends `{tap}` via `sendMessage`. If not reachable, it
   schedules an immediate local notification (glyph + street + distance; category `turn`) — iOS mirrors it to the wrist
   with a standard tap. Suppressed when the phone screen is on (the in-app banner already shows). Respects the existing
   notification-permission gate; never prompts from this path.
4. Watch: `WCSessionDelegate` writes the store, redraws the card, plays the haptic on `{tap}`, reloads complication
   timelines on `crew.live` change.
5. PTT: hold → `AVAudioRecorder` (AAC, tier params) → release → `transferFile` → phone module → `watchFile` event →
   `watchPtt` uploads via the existing POST; floor acquired on press-down (`sendMessage {ptt:'down'}`) and released on
   upload. Watch mic permission = the watch's own prompt on first press (documented exception to `permissionGate`).

## 5 · Haptic keep-alive — the spike, not a decision

Directional taps need the watch app reachable; a backgrounded watch app is not. Candidates, each behind a receipt:
(a) `WKExtendedRuntimeSession` started when a drive begins — HYPOTHESIS that its session types/duration fit a drive;
(b) `HKWorkoutSession` (the komoot pattern) — review risk for a driving app;
(c) fallback only — Tier-0 notifications, standard tap.
Spike 2 = a local dev-signed build on Jeff's phone + watch, three drives, read `watch-tap sent= reachable= via=msg|notif`
rows. The winner ships; the others stay out of the code.

## 6 · Error handling

- Not paired / no watch app installed → `watchFeed` never starts; zero cost.
- `sendMessage` errors → fall through to the notification path for taps; context updates never throw (queued by iOS).
- Watch app cold → first `applicationContext` renders the card; a stale payload (`at` older than 30 s) shows "Waiting
  for phone".
- PTT transfer failure → watch shows "not sent"; the phone side logs `watch-ptt fail=`.
- Android / web / older binaries → every entry point is a no-op (`requireOptionalNativeModule`).

## 7 · Receipts & gates

- Breadcrumbs (bounded, `logEventReliable`): `watch-ctx paired= reachable= app=` once per change; `watch-tap step= kind=
  side= via=msg|notif`; `watch-ptt ms= bytes= ok=`.
- Node gates: `tools/sim-qc/watch_taps_test.mts` (thresholds by speed, one tap per kind per step, left/right/generic
  mapping) and `tools/sim-qc/watch_feed_test.mts` (payload shape, on-change throttle, stale rule).
- trap-check rule: `watch-haptic-math-in-swift` — no distance/speed comparison in `targets/watch/*.swift`.
- Sim: paired iPhone 17 Pro + watchOS 26.5 sims with the existing `tools/sim-qc/drive.sh` route replay.

## 8 · Sequencing

1. **Spike 1 (sim, throwaway):** `targets/watch` "Hello" + `targets/watch-widget` → `expo prebuild --clean` → compile →
   embed → launches on the paired sims. Output = "apple-targets watch works / needs X".
2. **Spike 2 (Jeff's wrist, throwaway strategies):** module + card + taps behind the three keep-alive options.
3. Feature work per this spec; gates green; Codex review.
4. Build 77 cut with the rest of the list (`build-77-backlog`): runtime bump, both platforms at 77, Jeff's paid go.
