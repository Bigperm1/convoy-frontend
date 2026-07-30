# HANDOFF — Hairpin (Convoy) frontend

**Written 2026-07-25, end of an overnight session. Read this first, then `CLAUDE.md`
(build/release rules) and `CARPLAY.md` (the locked CarPlay spec).**

Shipped state: **build 68 · v3.4.0 · runtime 1.20.0** (cut 2026-07-25 — iOS store, Android
APK + Android AAB), OTA branch **`mapbox-migration`**.
**Post-68 OTAs go to runtime 1.20.0** (dual-publish with 1.19.0 until everyone is on 68).
Everything below marked "shipped" is live via OTA on 1.19.0 **and** 1.18.0 (always
dual-publish — build 66 testers are still on 1.18.0).

---

## 1. THE BIG OPEN ONE — Android Auto

**Still completely broken. Confirmed by Jeff on build 67 with the current OTA: the head
unit shows "Hairpin has encountered an unexpected error / Exit".**

- The bridgeless port **already shipped in 67** (`CarPlayService.kt`, `CarPlaySession.kt`,
  `VirtualRenderer.kt` rewritten onto `ReactHost`/`ReactSurface` — verified present in
  `patches/react-native-carplay+2.4.1-beta.0.patch`). It did **not** fix it.
- Ruled out: the `AndroidAuto` JS root **is** registered, at the entry point, in the right
  order (`index.js` imports `registerAndroidAuto` before anything car-related).
- **It is blocked on a stack trace, and guessing has already cost several rounds.** The
  failure is a native Kotlin exception thrown *before any JS runs*, so nothing lands in
  `crash_reports`, and it cannot be reproduced locally (the emulator ships a **stub**
  Android Auto; there is no DHU on this Mac).

**The trace is already engineered — it just needs build 68.** `AACrashLog` (in the patched
`CarPlayService.kt`) wraps all four car entry points, writes the stack trace to
`filesDir/aa_crash.txt` and rethrows unchanged. `src/androidAutoCrashLog.ts` (already live
via OTA) uploads and clears it on the next phone-app launch. So the moment 68 is on a
tester's phone: **drive, see the error, open the app later — the trace appears in
`crash_reports` tagged `android-auto-failure`.** Do not spend another session theorising
before that row exists.

---

## 2. Open issues, ranked

| # | Issue | State |
|---|---|---|
| 1 | **Android Auto** | Broken on 67. **Build 68 ships the black box** — get the trace (above). |
| 2 | **CarPlay doesn't re-mount after an app crash** | **Fix ships in build 68.** Reproduced + fixed; re-run the §3 table to confirm. |
| 3 | **CarPlay pinch-to-zoom** | Cold root fixed. Warm path still head-unit-only — see §4. |
| 4 | **Route line / off-route drift** | Free-drive "lost marker" is FIXED. Nav-time route-line polish still open. |
| 5 | **Heat** | Three real wins shipped tonight (§5). Needs a real drive to judge. |
| 6 | **Android Play submit** | Blocked on missing `play-store-service-account.json`. 67 AAB is built and Play-ready. |
| 7 | **Screen-off CarPlay** | Unfixed and unverifiable locally. |
| 8 | **Club switcher on Android** | `talk.tsx:625` still puts touchables in a ScrollView — probably fine now (§6) but never tested. |

---

## 3. CarPlay crash-restart — reproduced, fixed, awaiting build 68

Jeff: *"if you are connected to carplay and the app crashes it does not mount to carplay
smooth again — the only fix is to turn the car off and on again."*

**Reproduced in the CarPlay simulator.** Same rig, three runs:

| run | scenario | `carplayframework` lines | `Setting root template` |
|---|---|---|---|
| 1 | normal launch | 38 | 3 ✅ |
| 2 | **SIGKILL, then relaunch** | **0** | **0** ❌ |
| 3 | graceful quit, then relaunch | 38 | 3 ✅ |

Run 3 proves the sim's CarPlay display was still live, so this is the **crash path
specifically**, not a simulator limitation.

**Cause:** when the process dies while connected, iOS brings the CarPlay scene back
*active* without re-delivering `templateApplicationScene(_:didConnect:to:)`. RNCarPlay
therefore never learns the interface controller, `RNCPStore` stays disconnected, and JS's
`checkForConnection()` poke can never recover it — that native method early-returns on
`!isConnected`. **Nothing in JS can fix this.** A car power cycle works because it forces a
genuine fresh `didConnect`.

**Fix (already written into `plugins/withConvoyCarPlay.js`):** `CarSceneDelegate` now calls
`recoverCarPlayIfNeeded()` on `sceneDidBecomeActive` and `sceneWillEnterForeground`. If this
process holds no car window it never received a `didConnect`, so it connects straight from
the scene (`CPTemplateApplicationScene` exposes both `interfaceController` and `carWindow`).
Self-guarding via the weak `carWindowRef`: runs once per process on the recovery path,
never on the normal one.

**To verify after 68:** rerun the three-run table above. Run 2 must show non-zero.

---

## 4. CarPlay pinch-to-zoom

**The cold root had no zoom handlers at all** — connecting the head unit without opening the
phone app first meant no pinch whatsoever. Fixed and shipped.

The rest of the chain is verified end to end and is **not** the problem:
`mapTemplate.mapDelegate = self` (RNCarPlay.m:305) · native emits
`didBeginZoomGesture` / `didUpdateZoomGestureWithCenter` / `didEndZoomGestureWithVelocity` ·
all three present in the patched `MapTemplate.ts` `eventMap` · config types present ·
warm-root handlers present.

If pinch still fails **warm** on the head unit, the remaining suspect is Apple's own iOS-26
gating of raw map gestures. **Untestable locally — `carkitd` crashes in the iOS 26 sim.**

---

## 5. Heat work shipped tonight

Principle used: **cut work that produces no visible difference; do not downgrade anything
the driver can see.**

1. **Sub-pixel frame skip** (`ConvoyMapbox.tsx`) — the big one. The component re-renders its
   whole tree on every eased frame (the self-car's position/rotation are React props on the
   Mapbox layers); its own comment already called this *"the app's single biggest thermal
   load"*. A frame whose pose moved <6 cm and rotated <0.08° is now skipped. At z17 one
   physical pixel is ~0.25 m of ground, so such a frame **cannot** produce a different
   image. Nothing changes at speed; the saving lands on crawling traffic and idling in a
   mount. **Camera and marker skip together** — skipping the render while still pushing the
   camera would slide the map under a stale marker (the 2026-07-24 drift class).
2. **Water polygon poll** — was a `querySourceFeatures` every 2.5 s for the life of the map,
   just to pick boat-vs-car. Now skipped entirely when the car has moved <8 m.
3. **CarPlay connect poll** — was poking every 3 s **forever** on any phone that never
   connects to CarPlay (i.e. permanently, for every Android user). Now bounded to 60 s,
   re-armed on AppState-active and on disconnect.
4. Earlier the same night: **road-snap is now nav-only**, removing a 1.4 s tile query from
   every free-drive minute.

**GPS was deliberately left alone.** It is already tiered (premium plugged =
`BestForNavigation` 500 ms/2 m, eco = `High` 1 s/8 m) and does not run at all when
backgrounded and not navigating. Memory also records that a previous audit's
"remove the redundant CarPlay feed" recommendation was **verified wrong and rejected** —
`navNotification.ts` is the sole main-context `carStore` writer.

**Not yet judged:** whether this is enough. Needs a real drive with a phone in a mount.

---

## 6. Permissions + first-launch defaults (shipped)

- **No permission prompt fires at login any more.** `src/permissionGate.ts` serializes every
  OS prompt (one dialog at a time, 900 ms gap) so correctly-placed prompts still cannot
  stack. Placement alone can't prevent that — call sites don't know about each other.
- Push registration moved to `src/pushRegistration.ts` and split: `reportDevice()` never
  prompts and still runs at login (roster stays complete); `registerPushToken()` only fetches
  a token when permission is *already* granted.
- Location → asked on the **Map**. Mic → **Comms**. Notifications → **Comms**, awaited after
  the mic sheet. Apple Music → already user-initiated on **Music**.
- ⚠ **Not verified end-to-end.** Simulating a true first launch needs `pm clear`, which would
  wipe the signed-in emulator. `pm reset-permissions` is not enough — Expo tracks
  "have we asked?" in app storage, so it reports `denied`, not `undetermined`, and correctly
  declines to re-ask. **Watch a real fresh install.**

**First-launch defaults** (new installs only; existing testers keep their choices):
mid-drive callouts ON · road incidents OFF · weather ON · speed cameras OFF · place pins ON ·
audio stocks voice 80 / alerts 60 / comms 80 / transmissions 80.

**Removed from Settings:** "Hairpin Community" and "Check for Updates" (plus the orphaned
`settings/community.tsx`).

### ⚠ The RED PILL is the ONLY OTA pickup path — say nothing else
Jeff's standing call (2026-07-25): **"moving forward I want to stick with the red pill update
to keep it simple."** Two rival instructions were confusing testers, so there is now exactly one:

> Open the app, wait a few seconds on the map, tap the red **"Update ready — tap to install"**
> pill under the search bar.

`src/UpdateReadyPill.tsx` watches `Updates.useUpdates().isUpdatePending`, so it appears the
moment the bundle finishes downloading, and the tap calls `reloadAsync()` — the new JS runs
immediately. Hidden during turn-by-turn nav; returns when the drive ends.

**Never tell a tester "Settings → Software Update"** (the button is gone, and it lied anyway —
`checkForUpdateAsync` compares the server to what is DOWNLOADED, not what is RUNNING, which is
why it said "You're up to date" through the 07-09/07-11 stranded-OTA incidents). **Never tell a
tester to cold-start twice** — that is the dance the pill replaced. Only if the pill never shows
is the device stranded on the embedded bundle → `/ota-rescue`.

---

## 7. Build 68 — CUT 2026-07-25

Three builds at **v3.4.0 / runtime 1.20.0 / code 68**: `mapbox-ios` (store → TestFlight),
`mapbox` (internal APK → QR for sideloading), `mapbox-android-store` (AAB → Play, which
Android Auto needs to be enabled on production head units).

**Shipped in 68:** the Android Auto black box (`AACrashLog`), the CarPlay crash-restart
remount, CarPlay cold-root pinch-to-zoom, the Android glass fix (elevation halo), staggered
permission prompts, first-launch defaults, the heat sweep, and the dead-code removal.

**First thing to check after testers are on it:** query `crash_reports` for
`android-auto-failure` — that row is the whole reason 68 exists.

### Still open for build 69

1. **Mic arbiter** — a live bug *today*: expo-av allows one recorder and the loser's
   `setIdleAudioMode()` pauses the winner (`EXAV.m:275-279`). There is no arbiter; `useVoice`
   is mounted in three places, so **Scout can already truncate Scout**. Fix shape:
   `src/micOwner.ts` on the single-owner-by-priority pattern that killed the presence
   double-join. **Likely JS-only — try to OTA it before the build.**
4. **Headless mic core** — Scout + Comms PTT on a cold connect. `usePttChannel` is mounted in
   exactly one place (`talk.tsx`), so car transmit is dead even with the phone app open on
   the Map tab. Free win: `carDataService.ts` already runs a headless WebSocket and silently
   discards the `ptt`/`floor` frames it receives. Note hold-to-talk is **impossible** on
   CarPlay (`CPBarButtonHandler` is a single fire-on-select block) — use tap-to-toggle or VOX,
   and cut the 60 s cap to ~20-30 s for a driver who taps and forgets.
5. `CPWindow.mapButtonSafeAreaLayoutGuide` — replaces hand-measured insets tuned to one
   800×480 capture.
6. `buttonStyle` patch — written, **measured as a no-op on 18.6**, unprovable locally
   (carkitd crashes in the iOS 26 sim). Kept, inert.
7. iOS MBXImage refresh — garage class-asset refresh is still a native stub.
8. Missing class photos — motorcycle, verify electric (Jeff supplying).

---

## 8. Traps that have each cost at least one bad session

- **`patch-package` must exclude build output:**
  `npx patch-package react-native-carplay --exclude 'android/build/'`. Without it a stale
  Gradle tree gets swept in, producing a 382 KB patch of 342 files that **silently drops
  every real diff, including the whole Android Auto port.** Deleting the directory is not
  enough — patch-package's pristine reference still carries it. Always verify the file count
  after regenerating.
- **Never add a hook below `if (!coords) return` in `map.tsx`** (~:3040). Two crashes on
  2026-07-24; surfaces as an opaque native abort with no JS frames.
- **`pointerEvents` belongs on the PROP, not in a StyleSheet** on Android. A transparent mic
  glow (a 516 pt box anchored 108 pt *above* the mic) was swallowing every touch under it and
  killed the whole comms chip strip. Signature to recognise: the container still **scrolls**
  but its children get **no `onPressIn` and no press opacity**, while controls elsewhere work.
- **Never hinge driver-facing behaviour on a JS timer.** iOS suspends them while the phone is
  locked — which is how a phone sits in a mount. That is what left `CPAlertTemplate` modals
  stuck over the map and killed every CarPlay button.
- **Tile-clipped vector features are FRAGMENTS.** Any nearest-feature snap must handle
  "I drove off the end of this geometry"; the safe fallback is always the raw fix.
- **Verify with the device, not by reading.** iOS simulator automation now works (`attach` →
  `touch2_path` → `tap` → `screenshot`) and there is a **signed-in Android emulator**
  (`aa-test` AVD, SDK at `/opt/homebrew/share/android-commandlinetools`). Both caught fixes
  that were wrong but looked airtight.

---

## 9. Local test rigs

- **iOS / CarPlay sim** — device `0CA8F128-1592-4B7F-8E70-BA1AAA6F5519` ("Convoy iOS18
  CarPlay"), build 67 installed and signed in. Bundle-swap loop: build with
  `npx expo export:embed`, copy over `Hairpin.app/main.jsbundle`, relaunch. **Always
  crash-gate** (launch → ~20 s → still alive, zero JS errors) before publishing.
  Needs `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for `xcrun`.
- **Android emulator** — `aa-test`, build 67 installed **and signed in** (Jeff logged in
  2026-07-25 so Android bugs can be reproduced directly). Pulls OTAs normally: force-stop,
  launch, wait ~35 s, force-stop, launch. `uiautomator dump` + `dumpsys activity top` give
  real view bounds and clickable flags — that is how the chip bug was pinned.
  **Do not `pm clear`** — it would wipe that login.
- **Cannot be reproduced locally:** Android Auto (emulator ships a stub), iOS 26 CarPlay
  (carkitd crashes), screen-off behaviour.

---

## 10. Release discipline (short version — full rules in CLAUDE.md)

- OTA branch is **`mapbox-migration`**, never `preview`.
- **Dual-publish every OTA**: once at runtime 1.19.0, then flip `app.json` to 1.18.0, publish
  again, flip back. Leave `app.json` at 1.19.0.
- `yarn typecheck` **must** pass before publishing. (It was skipped once on a diagnostic OTA
  this session — Metro doesn't typecheck, so it ran on luck.)
- Never `eas build` or `eas submit` without Jeff's fresh go-ahead. Builds cost money.
- Every Android build also needs the `mapbox` internal APK + a QR + install link, unprompted.
- Testers need **two cold starts** to pick up an OTA.

---

## ★ CURRENT STATE — end of 2026-07-28

**ANDROID AUTO WORKS.** Confirmed on Say Phin's Toyota head unit, build 69 installed FROM
PLAY, wireless and wired. Cause was `CarPlaySession.kt:53` calling `registerReceiver`
without `RECEIVER_NOT_EXPORTED` — a `SecurityException` on API 33+ that killed
`onCreateScreen` every launch. Found from a real stack trace via the AACrashLog black box,
which itself had to be fixed first (SDK 54 moved `documentDirectory` out of
expo-file-system's main entry, so the reader had been a silent no-op and `crash_reports`
had ZERO android rows ever).

**⚠ AA testing MUST come from Play, never a sideloaded APK** — Android Auto hides
non-Play installs. That cost a full tester round-trip on 69.

**The AA HUD LAYOUT is fixed and ready to OTA (not yet published).** See §11.

### Shipped this session (all OTA, runtime 1.21.0, build 69 both platforms)
- **ETA rebuilt on per-segment durations** + a 2-minute Directions-Refresh loop for live
  traffic/construction. The old flat distance-ratio drifted up to **16 min** on a real
  Langley→Anglemont route; the new one measured 0.000s error at every sample.
- **Add stop** — renameable waypoints via `fetchRouteViaStops`; keeps segment durations,
  congestion and the refresh uuid, so accurate ETA and live traffic work through stops.
- **Pitstop** timer (phone + CarPlay), routed-only, candy-red countdown.
- **Drives** — recorded KM, history, totals; **route playback** + "take it again".
- **Club leaderboard** — Drives / PB tabs.
- Crew-over-compass ordering, white crew/club text, CarPlay compass = the phone needle.

### Not yet verified by a human
- Route playback animating, and recorded distance looking sane
- Pitstop firing at a real fuel stop (phone and car)
- **One route driven to arrival proves all of these at once.**

### Gotchas earned the hard way this session
- **Check WHICH BUILD is running before debugging a "broken" fix.** Four speculative fixes
  chased a stale OTA on the leaderboard; the answer was visible in a screenshot the whole
  time. Read the map pill: runtime must match `app.json`, tag must not be `emb`.
- `/communities/:id` did NOT project `top_speed_record`; fixed in the backend repo
  (`~/convoy-backend`, pushed) — clubs live on the custom backend, not Supabase.
- `public.trips` is aggregate-only BY DESIGN (no coordinates): there is no Supabase Auth,
  so RLS cannot scope reads to "your own rows". Route geometry stays on the device.

---

## 11. Android Auto HUD overlap — ROOT-CAUSED AND FIXED (2026-07-28, awaiting OTA)

Say Phin's head-unit photo showed the speedo and the maneuver distance printed on top of
each other as `0124 m`, `km/h` tucked underneath, the `20°C` chip over the ETA line, and
"Turn right …" clipping.

**The canvas is ~250 × 143 dp** — measured from the photo itself, not assumed: the crew pill
is `CREW_PILL_H = 22`dp with 11pt text, and on that screen it fills ~15% of the canvas height
and ~85% of its width. That is a THIRD of the area this HUD was tuned for (400×240pt of
CarPlay). A head unit reports few dp for a physically large screen, so one dp up there is
~4–5× the physical size of a phone dp — which is why every chip in that photo looks enormous.
**Two independent defects follow from it.**

**Cause 1 — a width floor, nothing to do with the canvas being "crowded".** `navStackW` did

```
Math.max(NAV_STACK_ABS_MIN_W, Math.min(NAV_STACK_MAX_W, surfaceW - left - right))
```

while the comment directly above it claimed "clamp DOWNWARD only". So when only ~88pt were
free the stack was still forced to 120pt — and because the stack is anchored RIGHT, that
surplus grew **leftward, straight over the speed cluster**. CarPlay never exposed it: a
~431pt CarPlay canvas always had the room. The Android Auto canvas is a VirtualDisplay
sized by the head unit (`VirtualRenderer.kt:44`) and is much narrower.

Feeding 250dp back through the shipped code reproduces the photo to within a few dp:
`navAvail = 250 − 184 − 48 = 18`, forced up to the 120 floor, banner left edge at x=82 over a
speedo spanning 56–114 — `0124 m`. The ETA row lands at y 61–85 over a weather chip at y
33–81, in x 82–114 — `20°C` on the ETA line. Both complaints, same arithmetic.

**Cause 2 — everything is drawn ~2× too big for the canvas.** The reflow below is necessary
but was not sufficient on its own: three stacked rows at full size (42 + 8 + 24 + gaps) are
~74dp of a 143dp canvas and would have swallowed the map.

**Fixed (`src/carplay/ConvoyCarPlay.tsx`), all JS/OTA:**
- **`hudScale` = `min(1, max(0.5, min(W/400, H/240)))`, Android Auto only.** Each cluster is
  scaled about the corner it is pinned to (`transformOrigin`), so its anchor does not move and
  only its footprint shrinks. ⚠ Three derived **positions** had to be re-derived from the
  *scaled* height or they detach from what they sit against — the status row under the crew
  pill, the weather chip on the speedo, and the tight-canvas stack. If you add another
  position expressed as "10 + 48 + …", it needs the same treatment.
  At the measured canvas: scale 0.6, stack spans x=137–238 against a speed cluster ending at
  84 (**117dp clear**), stack height 31% of the canvas instead of 52%.
  **AA only on purpose** — the CarPlay surface is verified good and its own height has never
  been measured here; scaling it on a guess would risk a known-good surface.
- **Tight-canvas reflow.** When the nav stack and the speed cluster cannot share the bottom
  band, they stop sharing it: the stack goes full width and lifts one row, and the weather
  chip slides *beside* the speedo instead of above it. With `hudScale` in place no measured
  geometry reaches this — it is now a backstop, and one that can no longer fill the screen
  because the rows it stacks are scaled too. Which layout applies is decided by arithmetic
  (`navAvail < NAV_STACK_ABS_MIN_W`), not by a tuned constant.
- **AA drops the CarPlay-only chrome insets.** `left: 56` and `right: 48` exist to clear
  iOS's leading/trailing map-button rails, which do not exist on a head unit — 80pt back.
- **One-shot canvas probe.** `logAaCanvas()` writes `android-auto-canvas surface=WxHdp …`
  to `crash_reports` on the first layout of a car session. One drive replaces "narrower
  than CarPlay" with a number. **Query that row before tuning anything else.**

### ⚠ The theory that was wrong — do not act on it again
It looked obvious that androidx already draws a maneuver card and travel estimate from what
`AndroidAutoRoot` pushes, i.e. that we double-draw. **It has never received them.**

```
CarPlayModule.kt:123   val screen = carScreens[name]
```

`name` there is the NATIVE MODULE's `getName()` — `"RNCarPlay"`. `carScreens` is only ever
keyed by `"root"` and by templateId, so the lookup always misses and the entire update body
is skipped: **`updateTemplate` is a silent no-op on Android.** Every pixel of nav chrome on
that head unit is ours. Deleting our maneuver banner and ETA "because the car draws them"
would have left an AA driver with neither — that edit was written, then reverted when the
Kotlin was actually read.

`AndroidAutoRoot.tsx`'s payload was corrected anyway (`info`/`step` nesting, string
`distanceUnits`, the required `destinationTime`), because the moment that lookup is fixed a
wrong shape stops being harmless — see below.

### Build 70 — the native half (patch-package, needs a paid build)
Land together or not at all:
1. `updateTemplate` → resolve the screen by templateId, falling back to `currentCarScreen`.
2. `parseTemplate` runs inside a bare `handler.post {}` with **no try/catch**
   (`CarPlayModule.kt:120-133`), so a parser throw is uncaught on the car app's MAIN
   THREAD — a crash, not a warning. Wrap it before enabling (1).
3. `parseTravelEstimate` does `getMap("destinationTime")!!`, `parseRoutingInfo` does
   `getMap("step")!!`. The OTA above already sends both; re-verify against `RCTTemplate.kt`
   (the library's own TS types disagree with its Kotlin) before patching.

Only once the car is genuinely rendering chrome is it worth deciding which elements to hand
back to androidx.

Also still unplumbed: `SurfaceCallback.onStableAreaChanged` / `onVisibleAreaChanged` —
`VirtualRenderer.kt:30` implements only `onSurfaceAvailable`. Those callbacks are androidx
telling us exactly which rect its chrome does not cover, which is the real end state for
this layout instead of insets we guess at.

### Verification done
- `yarn typecheck` clean; eslint unchanged from baseline (0 errors).
- iOS release bundle swapped into the installed sim build (device
  `0CA8F128-…`): boots and renders the same screen as a control bundle built from HEAD, no
  JS errors, `setRootTemplate` returns `error (null)`. The first screenshot was BLACK and
  looked like a regression — it was a slow first launch, proven by re-running the identical
  bundle. **Always run the control.**
- iOS render paths are unchanged by construction: every branch added is gated on
  `Platform.OS === 'android'` or on a width threshold a CarPlay canvas does not cross. The
  reworked width maths was checked numerically to return **bit-identical** results at
  375 / 400 / 431pt (135.9 / 150.0 / 167.5) against the old expression.
- `transformOrigin` keyword strings (`'left bottom'` etc.) confirmed supported in RN 0.81 —
  `Libraries/StyleSheet/processTransformOrigin.js`.
- **NOT verified:** the head unit itself, and the 250×143 figure is photo-derived, not read
  from the device. Needs one AA drive on the OTA → the `android-auto-canvas` row gives the
  real number, and a fresh photo says whether 0.6 is the right size to read at arm's length.
  `HUD_SCALE_FLOOR` / `CAR_REF_W` / `CAR_REF_H` are the tuning knobs; all OTA-able.

---

## 12. Drive report 2026-07-29 — four items, all root-caused (awaiting OTA)

Screenshots: phone at 12 km/h with a fully green line; CarPlay at 3 km/h same moment;
a second drive where congestion coloured correctly; two head-unit photos.

### 1. Route line touching / overlapping the car — `src/routeTrim.ts` (NEW)
Jeff: *"one day it'll be 30 m away from the car, the next drive it'll be touching, the next
overlapping — consistent for all speeds on CarPlay, Android Auto and phone."*

Two structural causes.

**The surfaces disagreed.** Phone `clamp(12 + speed*1.6, 30, 100)` vs `CarMapView`
`clamp(10 + speed*1.1, 10, 55)` — and CarMapView draws BOTH CarPlay and Android Auto. 30 m
of clearance on the phone, 10 m in the car, at a standstill. The phone's floor had been
raised 12 → 30 m *specifically* because a short lead let the line touch the marker; the car
surface never got that fix.

**A lead in metres cannot track a marker measured in pixels.** `CAR_MODEL_SCALE_BY_ZOOM` is
geometric at ~2× per zoom level (13 at z17 → 120 at z14). That is deliberate: it cancels
metres-per-pixel so the car reads the same SIZE on screen at any zoom. The consequence is its
footprint in ground metres DOUBLES per zoom level out — ~20 m at z17, ~185 m at z14 — and the
chase camera zooms out with speed. Clear space in front of the nose, in screen points:

| km/h | zoom | old | new |
|---|---|---|---|
| 0 | 17.0 | 51 dp | 51 dp |
| 70 | 15.5 | 13 dp | 51 dp |
| 100 | 13.9 | **−8 dp** | 51 dp |
| 140 | 13.4 | **−10 dp** | 51 dp |

Negative = the line starts *inside* the marker. All three reported behaviours in order as
speed rises — it looked per-drive because it is per-SPEED, through zoom.

Fixed by measuring the lead where the driver judges it: a fixed SCREEN distance converted at
the live camera zoom, so it grows exactly as fast as the marker. One function, all three
surfaces, each passing its own zoom (CarPlay including pinch bias). **`TRIM_LEAD_DP` is the
knob.** Deliberately **no pitch term** (marker and gap share the foreshortened ground plane,
so the ratio is unchanged) and **no speed term** (zoom already carries speed).

### 2. Congestion green through an hour of traffic — ⚠ NOT ROOT-CAUSED YET
**The first diagnosis was WRONG and has been retracted.** It claimed
`fetchMapboxRouteVia` omitting `enable_refresh=true` meant no `uuid`, so the refresh loop
never armed and the snapshot froze. Tested against the live API on 2026-07-29: **the identical
request returns a uuid with or without that parameter.** `refreshUuid` was never undefined and
that fixed nothing. (The parameter was kept — it is the documented way to get a refresh handle
and relying on an undocumented default for something load-bearing is a bad trade.)

What the live API testing DID establish, on Jeff's own corridor:
- **44–73% of segments return `congestion_numeric: null`** → `unknown` → painted the SAME brand
  green as `low`. A driver cannot tell "no data" from "clear".
- Three highway segments moving at **under half the posted limit** were labelled `low`.
- But `congestion_numeric` is **not simply broken**: on a longer Hwy 1 Surrey→Abbotsford run it
  called 19 of 24 sub-50%-of-posted segments `heavy` or `severe`, correctly.
- A speed-vs-posted-limit derivation was considered as a replacement signal and **rejected**:
  `maxspeed` is present on only ~40% of segments, and on ramps and light-controlled streets a
  low live/posted ratio is normal, so it would paint false jams. (Also note `depart_at` did not
  return typical-time traffic here — it echoed the current annotations — so any "rush hour"
  measurement through it is worthless.)

So two very different bugs remain in play and **nothing readable from this machine separates
them**: (a) the app held heavy/severe and failed to PAINT it, or (b) Mapbox reported
low/unknown for that road and the paint was faithful.

**A probe now answers it.** `map.tsx` logs a `congestion-probe` row to `crash_reports` when
guidance starts and then only when the WORST level changes — level counts plus current speed.
One drive in traffic decides (a) vs (b). **Query that row before touching the paint code.**

Two genuine robustness fixes did land, neither of them proven to be Jeff's bug: the refresh now
runs once immediately instead of first firing two minutes in, and `refreshMapboxRoute`
distinguishes `"expired"` from a transient failure — it returned plain `null` for everything, so
three patchy-signal ticks were read as route expiry and switched live traffic off for the rest of
the drive, on a road trip.

Two more hardenings: the refresh now runs **once immediately** instead of first firing two
minutes in, and `refreshMapboxRoute` distinguishes `"expired"` from a transient failure — it
returned plain `null` for everything, so **three patchy-signal ticks were read as route expiry
and switched live traffic off for the rest of the drive**, on a road trip.

⚠ Still true and worth knowing: congestion `unknown` (no Mapbox data) paints the SAME brand
green as `low`, so "clear" and "no data" are indistinguishable on the line.

### 3. Crew button didn't return to the chase cam ("weird 3-D view")
`crewFit` pinned north via `setCarNorthUp(true)` — a latch whose only release is
`useEffect(… [s.navigating])`, which **cannot fire if you were already navigating when you
tapped it**. The 15 s hold expired, the lockstep took position, pitch and zoom back, and the
heading stayed frozen at north: a pitched camera facing north instead of down the road, for
the rest of the drive. North-up is now derived from the hold timestamp inside `getCam`, which
runs per frame in the rAF loop — the same loop that reads the override one line after calling
it. A timestamp comparison, **not** a `setTimeout` (iOS suspends JS timers while the phone is
locked, i.e. in a mount).

### 4. Add stop — kept the original route, no pin, no tap-to-add
Not a failed fetch. **`onOffRoute` re-plotted with plain `fetchRoutes(coords, destination)` —
no stops.** Adding a stop mid-drive swaps in a via-route whose first leg can leave the road
the car is on, so the engine reports off-route once during the swap; this handler then
re-plotted *without* the stops and `setRoutes` threw the via-route away, restoring the exact
original line while the chips still showed the stop. The faster-route checker had the same
hole: its candidates come from a plain origin→dest fetch, so every one SKIPS the stops and
accepting one would delete the trip. **Offers are now suppressed while stops are pinned.**

Added: numbered stop PINS on the map, and **double-tap with a trip plotted → add a stop**
(including mid-drive; with no destination the gesture still drops a destination and keeps its
mid-guidance guard). The via-fetch fall-through now toasts instead of silently showing the
direct route.

### Verification status
`yarn typecheck` clean, eslint identical to baseline on every touched file, and the trim table
above is arithmetic. **None of it has been driven.** One route with a stop, in traffic, past a
crew-button tap, proves all four at once — and the trim needs a look at both the phone and a
head unit at low AND highway speed.

---

## 13. Scout re-organises the stops (2026-07-29, shipped OTA)

Jeff: *"Scout should reroute the best route based on the two added stops and the end
destination — it should re-organise the route stops. With Google Maps I have to
re-organise them myself. We should have as many added stops as you want, no limit."*

Origin and final destination are pinned; everything in between is re-orderable — TSP with
fixed endpoints. `src/routeOptimizer.ts`.

**The LLM is deliberately not in this loop.** Scout *announces* the result; it does not
decide it. An LLM guessing a visiting order would be slower and occasionally wrong, and
wrong here means sending the driver the long way with nothing on screen to reveal it.

### ⚠ The caps are MEASURED, not assumed — don't re-derive them
Each was found by walking the coordinate count up until the API returned 422:

| API | cap | usable stops |
|---|---|---|
| Optimization v1, `driving-traffic` | 12 coords | **10** |
| Matrix, `driving-traffic` | 10 coords | too small to use |
| Matrix, `driving` (free-flow) | 25 coords | **23** |
| Directions, `driving-traffic` | 25 coords | **23** ← hard wall |

- **≤10 stops** → Optimization API, `source=first&destination=last&roundtrip=false`.
  Exact and traffic-aware. Verified on deliberately scrambled stops: returned west→east
  with both ends pinned.
- **11–23 stops** → free-flow Matrix + nearest-neighbour + 2-opt on the device, endpoints
  never moved. Verified on 12 shuffled stops: 293 min as tapped in → 160 (NN) → **107**
  (2-opt), recovering a perfectly monotonic west→east order.
- **>23 stops** → the route **cannot be drawn at all**; Directions refuses >25 coordinates.
  "No limit" is not achievable in one request. The driver is told rather than having stops
  silently dropped. Going further needs multi-request leg stitching, which would break the
  single refresh uuid and the one-axis segment ETA that the accurate ETA **and** the
  congestion gradient are both built on. Mapbox Optimization **v2** (time windows, more
  stops) exists but needs beta access — that is the route to a higher ceiling.

### Integration notes
- Reordering `stops` is the whole integration: the route-fetch effect already keys on it,
  and `onOffRoute` now preserves stops (§12.4) so nothing un-does the new order mid-drive.
- **Loop guard keys on the stop SET, not the order.** Reordering the same set must not
  re-trigger the pass or `setStops` feeds itself forever.
- Savings are claimed only when measurable like-for-like: the matrix tier scores both
  orders off the same matrix (exact); the Optimization tier has no comparable figure and
  so just says it reordered rather than inventing a number.
- The rename-stop modal is now keyed by **coordinates, not array index** — a reorder while
  it was open used to rename whichever stop landed in that slot.

### Double-tap semantics (Jeff's call, confirmed)
While routing, double-tap = **"go past here"** → adds a stop. With no destination set it
still drops a destination, and that path keeps its mid-guidance guard.

### Not yet verified by a human
Everything above is API-verified arithmetic, not a drive. One trip with 3+ deliberately
out-of-order stops proves it: the chips should visibly reorder, Scout should say so, and
the line should pass through them in the new order.

---

## 14. Cruise planner, real Scenic routes, and Scout's road knowledge (2026-07-29/30)

All shipped OTA on runtime 1.21.0 and **verified on the signed-in simulator**, not by reading.

### Scenic is now a ROUTE, not a label
`routeKindFor` called index 0 "best" and index 1 "scenic", so the drive map's Scenic was only
Mapbox's first alternate — usually another freeway in a different colour. It now fetches its
own **motorway-free** route and REPLACES that alternate (leaving it would have labelled the
freeway "scenic" too — two scenic-coloured lines). Skipped when it duplicates the fastest line
or exceeds 2.5× its time, since motorway-free across a mountain range is a mistake, not a
scenic route. Verified SF→Palo Alto: **Best 36 min** (freeway) vs **Scenic 1h 19m** (peninsula).

The cruise planner uses the same definition, so the two surfaces finally agree.

### The cruise planner (`src/components/CruisePlanMap.tsx`)
Route drawn through meeting point → stops → end, pinch/zoom, **tap the map to add a stop**,
nameable stops, Direct/Scenic chips with real times, Scout's stop re-ordering behind a button
(a scenic cruise is often deliberately "inefficient", so auto-optimising would wreck it).
Deliberately NOT built on ConvoyMapbox — that is the drive surface (chase cam, peers, road
snap); a planner wants the opposite of a follow camera, and separating them means nothing here
can perturb the map people navigate with.

**Three bugs that only a screenshot caught:**
1. The map opened on **New York** with the meeting point set to Horseshoe Bay — the initial fit
   ran before the GL map finished loading and `setCamera` was silently dropped (the same trap
   `CarMapView`'s cold-start snap exists for). It now also fits on `onDidFinishLoadingMap`.
2. Fitting only the FIRST point set meant adding an end location never re-framed. The rule is
   "fit until the planner takes the wheel" — stop on the first pan/pinch, re-frame button
   hands control back.
3. The chips read **"Fastest 9 min" beside "Scenic 4 min"** — avoiding a motorway around an
   interchange can genuinely be shorter, so the label was falsifiable on screen. Titles now
   describe what each route IS (Direct / Scenic) and the quicker one is marked from the data.

### Scout's road knowledge — DEPLOYED
`POST /api/routes/scenic-suggest` (`~/convoy-backend`, pushed 2026-07-30, live on Render) +
`src/scoutScenic.ts`. Verified end-to-end on device from Horseshoe Bay: Porteau Cove,
Brandywine Falls, Sea to Sky Gondola — each with a one-line reason, geocoded to real pins,
route re-plotted.

⚠ **The model returns searchable NAMES, never coordinates.** That is the safety property:
asked for lat/lng a model will produce plausible numbers for a place that does not exist, and
an unverifiable waypoint would send a convoy down a road that isn't there. Names resolve
through real place search or are dropped. **Never "improve" this by asking for coordinates.**

Ordering stops and choosing between routes stays exact maths (Optimization / Matrix /
Directions). The model is only ever asked what it alone knows: which roads are worth driving.

### Still not verified by a human
A real drive. §12's `congestion-probe` row is the one to query first if the green-line-in-
traffic report recurs.
