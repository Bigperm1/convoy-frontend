# HANDOFF — Hairpin (Convoy) frontend

**Written 2026-07-25, end of an overnight session. Read this first, then `CLAUDE.md`
(build/release rules) and `CARPLAY.md` (the locked CarPlay spec).**

Shipped state: **build 67 · v3.3.0 · runtime 1.19.0**, OTA branch **`mapbox-migration`**.
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
| 1 | **Android Auto** | Broken. Needs build 68 for the black box (above). |
| 2 | **CarPlay doesn't re-mount after an app crash** | **Fixed in the plugin, needs build 68.** Reproduced + fix written; see §3. |
| 3 | **CarPlay pinch-to-zoom** | Cold root fixed (shipped). Warm path unverified — see §4. |
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
⚠ **Check for Updates was the documented manual OTA-rescue path.** The always-on
`UpdateReadyPill` on the map still covers a stranded bundle, so the escape hatch survives —
know this before a tester is stuck.

---

## 7. Build 68 backlog

Nothing native has shipped since 67. A build would take runtime to **1.20.0** and **must
cut BOTH platforms** (a runtime bump only "takes" for the platform actually rebuilt).

1. **Android Auto black box** (`AACrashLog`) — the reason to cut 68 even without a fix.
2. **CarPlay crash-restart recovery** (§3) — written, needs the build.
3. **Mic arbiter** — a live bug *today*: expo-av allows one recorder and the loser's
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
