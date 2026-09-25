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

# CARPLAY.md — the locked CarPlay / Android Auto spec

**Status: LOCKED as of 2026-07-24 (runtime 1.19.0, build 67).** The layout and button
behaviour below were signed off on the head unit ("perfect"). Treat every number here as
load-bearing. If you change one, re-read the *Derived, not tuned* section first — several
constants are computed from each other, and breaking that coupling is how the car marker
ended up under the banners three times.

Files: `src/carplay/ConvoyCarPlay.tsx` (surface + templates), `src/carplay/CarMapView.tsx`
(map + camera), `src/carplay/carActions.ts` (buttons + headless actions),
`src/carplay/carStore.ts` (shared state), `app/(app)/map.tsx` (warm mirror + crew feed).

---

## 1. Screen layout

```
┌──────────────────────────────────────────────────────────────┐
│ [−][+]       « N Crew · v67 · 1.19.0 »        [Search] [End] │  nav bar (system)
│                                                              │
│                                                              │
│  ┌────────┐                                                  │
│  │ 21°C   │  weather                                          │
│  └────────┘                                   ┌────────────┐ │
│  ┌────────┐                          🚗       │ ETA banner │ │
│  │  0     │  speedo                  car      ├────────────┤ │  ← car sits on
│  │ km/h   │                        (on the    │ turn banner│ │    THIS gap line
│  └────────┘                         gap line) └────────────┘ │
│                                                     (mic) ● │  map buttons
│                                                 (hazards) ● │  (system, right edge:
│                                                   (2D/3D) ● │   mic, hazards, view,
│                                                    (crew) ● │   crew — top→bottom)
└──────────────────────────────────────────────────────────────┘
```

**Top bar** — leading: **zoom − then zoom +** (Jeff, 2026-08-15; the mic and 2D/3D that
used to sit here moved to the map-button column). Centre: crew pill. Trailing: Search
then End (End at the far corner). *The trailing array is REVERSED vs visual order* —
`[car-end, car-search]` renders as "Search End". Head-unit verified; do not "fix" it.

**Right edge (map buttons, top→bottom)** — comms mic, hazards, 2D/3D view, crew (Jeff,
2026-09-24: "Top - mic, Second from top - hazards, Second from bottom - 2D/3D, Bottom -
crew"; the compass is a tile inside the Report grid)
(4-button array; CarPlay's panning mode hides from the END, so 2D/3D and crew are the
sacrificial pair and zoom always survives in the nav bar). The 2D/3D toggle only became
functional with this move — as a bar button its id had no handler branch.

**Banner stack** — right-anchored, bottom-anchored, TWO rows sharing ONE width:
ETA, turn (bottom).

> **The lane/arrow row was REMOVED 2026-08-13** on every surface — phone, CarPlay and
> Android Auto — at Jeff's request ("lets completely remove the turn arrow banner from
> phone and carplay/aa"). It used to be the top row of this stack and appeared only
> within 600 m of a maneuver. Its whole data path went with it: `carStore.lanes`, the
> cold engine's lane fetch in `navNotification.ts`, and map.tsx's per-session Mapbox
> Directions call. Do NOT re-add it from this spec's history.

---

## 2. Layout constants

`ConvoyCarPlay.tsx`:

| Constant | Value | Meaning |
|---|---|---|
| `CAR_TOP_INSET` | 58 | clears the nav bar |
| `CAR_RIGHT_INSET` | 48 | banner right edge → screen edge. Glass buttons start ~41pt in, so this leaves ~7pt |
| `NAV_STACK_BOTTOM` | 8 | banner stack → screen bottom |
| `NAV_GAP` | 8 | gap between every row (matches the system's own button pitch) |
| `NAV_PILL_H` | 24 | ETA row height (was shared with the removed lane row) |
| `TURN_ROW_H` | 42 | taller: maneuver box + two text lines |
| `NAV_STACK_MAX_W` | 260 | upper clamp; the stack grows to this on wide units |
| `NAV_STACK_ABS_MIN_W` | 120 | floor; below this it is unreadable |
| `CAR_LEFT_INSET` | 184 | speed-cluster bound (speedo 56 + slid-out limit badge) |
| `CAR_MODEL_HALF_W` | 20 | half the car model on screen, for clearance math |
| `CREW_PILL_H` / `CAR_PILL_TOP` | 22 / 4 | crew pill |

`CarMapView.tsx`:

| Constant | Value | Meaning |
|---|---|---|
| `CAR_LOWER_PAD_FRAC` | 0.52 | floor for the vertical anchor |
| `CAR_LEFT_PAD_FRAC` | 0.13 | horizontal: car sits at `W*(1-frac)/2` |
| `CAR_BANNER_STACK_BOTTOM` + `CAR_BANNER_GAP_SCALABLE` | 8 + 46 (= 54 on CarPlay) | **= NAV_STACK_BOTTOM + TURN_ROW_H 42 + NAV_GAP/2 4.** Split because on Android Auto only the second half is inside the hudScale transform |
| `CAR_ZOOM_OUT` | 0 | camera MATCHES the phone — standing rule |
| `CAR_PITCH_BONUS` | 0 | same |

---

## 3. Derived, not tuned — do not hard-code these

Two positions are **computed** so they cannot drift apart. Both replaced fixed numbers
that broke on a different-width head unit.

**Car ↔ banner horizontal clearance.** `ConvoyCarPlay` imports `CAR_LEFT_PAD_FRAC` from
`CarMapView` (the same constant the camera uses), computes the car's on-screen x, and
keeps the stack right of `car + half-width + gap`:

```
carX        = surfaceW * (1 - CAR_LEFT_PAD_FRAC) / 2
carClearLeft= carX + CAR_MODEL_HALF_W + NAV_GAP
navStackW   = clamp(ABS_MIN, MAX, surfaceW - max(CAR_LEFT_INSET, carClearLeft) - CAR_RIGHT_INSET)
```

Result: a guaranteed **8pt gap at every canvas width** (400/420/480/560 all verified), and
the banner widens on bigger screens instead of being pinned to one number.

**Car vertical anchor.** Mapbox centres the camera in the *inset* rect, so the car sits at
`(h + paddingTop)/2`. To place it on the turn↔ETA gap line:

```
gap       = CAR_BANNER_STACK_BOTTOM + CAR_BANNER_GAP_SCALABLE * hudScale
paddingTop = clamp(h*CAR_LOWER_PAD_FRAC, h*0.72, h - 2*gap)
```

Exact at 240/280/320pt. **If you change `NAV_STACK_BOTTOM`, `TURN_ROW_H` or `NAV_GAP`, update
`CAR_BANNER_STACK_BOTTOM` / `CAR_BANNER_GAP_SCALABLE` to match** — that is the one manual coupling left (CarMapView cannot import ConvoyCarPlay; the dependency runs the other way).

---

## 4. Buttons — what each does

| Button | Kind | Action |
|---|---|---|
| mic (top-left) | CPBarButton image | `toggleCarComms()` — tap-to-toggle crew PTT, 25s cap |
| Search | CPBarButton text | pushes CPSearchTemplate; empty query lists saved places |
| End | CPBarButton text | **full stop** — `endNavFromCar` also clears destination + route |
| crew | CPMapButton | `crewFit` — frames self + all peers, north-up, 15s camera hold |
| hazards | CPMapButton | pushes the Report grid (`openHazardPanel`, `src/carplay/hazardPanel.ts`): Police / Crash / Hazard / Traffic report at the car's position from 5 s ago (`reportHazardFromCar`), Compass fires `compass`; a tile pops the grid, and an untouched grid pops itself after 8 s (`HAZARD_PANEL_AUTO_CLOSE_MS`, both head units and the phone sheet — Jeff, 2026-09-25) (2026-09-24, replaced the compass button on Jeff's word) |
| compass (tile) | CPGridButton | `compass` — recenter + face north, toggles, auto-releases on nav start |

Flow: `onMapButtonPressed`/`onBarButtonPressed` → `handleCarMapButton`/`handleCarBarButton`
(carActions) → `emitCarGesture` → `CarMapView`'s gesture subscription.
Android Auto mirrors the same ids (`aaMapButtons`); its Report grid is `createTemplate('grid')` + `pushTemplate`, the
press arrives as `gridButtonPressed` with our template id, and `backButtonPressed` pops it (HYPOTHESIS, never seen on a
unit or the DHU: the androidx host tints the tile art white — our bridge's `parseCarIcon` sets no tint).
The phone has the same panel (2026-09-24, Jeff: "WHERE IS THE HAZARDS BUTTON ON THE PHONE?"): a Hazards FAB on TOP (Hazards · 2D/3D · Crew — the head unit's column minus the mic; the compass is a tile inside the panel on the phone too, 2026-09-25); the Report panel (`src/components/HazardSheet.tsx`) floats ABOVE that stack, centred, on the weather forecast card's floor, with
the same five tiles as the head units (`hazardPanel.ts` `HAZARD_TILES`, the Compass tile included). A tile reports through
`map.tsx reportHazard` (the voice intents' path). The pins are the same baked category-coloured teardrops on every surface
(Police = EV teal, Crash = Hospital red, Hazard = Fast Food amber, Traffic = Gas orange, the Apple-symbol glyph on the head —
`src/hazardPinImages.ts`; `HazardMarker` draws the identical PNG on the head units). Full spec: `HAZARDS.md`.

**Warm vs cold.** With the phone app open, `ConvoyCarPlay` intercepts some ids first and
calls live refs *directly* (never the bus) — don't hunt for a bus event on the warm path.
Cold falls through to the module-scope handlers.

---

## 5. Hard-won rules (each cost at least one bad build)

1. **NEVER add a hook below the `if (!coords)` render early-return in `map.tsx`.** Two crashes
   on 2026-07-24. With no GPS fix the hooks don't run; when coords arrive the count changes →
   *"Rendered more hooks than during the previous render"* → surfaces as an opaque native
   abort with no JS frames. The CarPlay crew feed sits above it for this reason.
   > **Find it by content, not by line:** `grep -n 'if (!coords) {' "app/(app)/map.tsx"` — the
   > one returning `<Text>Locating…</Text>`. Crew feed: `grep -n 'CarPlay crew feed'`.
   > This rule previously read `:2980` and `:1666`. Both had drifted by ~1,200 lines and
   > pointed at unrelated code — which is exactly how someone re-introduces the crash the
   > rule exists to prevent. **No line numbers here on purpose:** when this was corrected on
   > 2026-08-30, adding the fix comment to `map.tsx` shifted the target three lines and
   > invalidated the freshly-written number on the spot.
2. **The iOS 26 spacer trick is DEAD.** Transparent images and `hidden:true` both still
   draw the glass circle. Two head-unit confirmations. Do not revisit.
3. **`Camera.fitBounds` silently no-ops on the CarPlay window** (works in the 18.6 sim).
   Use explicit `setCamera` with a computed zoom — that is proven every frame by the chase cam.
4. **Buttons cannot be restyled.** `CPMapButton` = image/focusedImage/enabled/hidden;
   `CPBarButton` = image/title/enabled/buttonStyle. No colour/material/tint anywhere in the
   framework. Their glass is drawn by iOS 26. Only *our* surfaces can be changed to match.
5. **Our own drawn UI is never tappable** — CarPlay routes touches through the template only.
   Anything we draw is a readout.
6. **The warm mirror must OMIT nav fields while phone-tbt is idle, never write `''`** — it
   was blanking the cold engine's ETA on car-started routes every tick.
7. **A pushed template needs (a) an already-presented guard and (b) an automatic way home.**
   Re-pushing the same instance corrupts the stack (renders, takes no touches), and a modal
   over the map hides every map button. Search auto-pops once moving.
7b. **NEVER present a template for routine feedback — that was the recurring "CarPlay buttons
   not working".** Root-caused 2026-07-24 in the sim with a broken-mode control: eleven call
   sites raised a `CPAlertTemplate` for confirmations ("Route ended", "Routing to X", every
   comms-mic message). The alert covers the map, so every button dies — and its only escape
   was a 2600ms `setTimeout`. **iOS suspends JS timers while the phone is locked, which is
   how a phone sits in a mount**, so the dismiss never fired on a drive while the sim (fore-
   grounded, unlocked) always cleared it in 2.6s and looked fine. Routine feedback now goes
   to the non-blocking pill on our own surface, expiring by TIMESTAMP COMPARISON at render.
   **Corollary: never let anything a driver depends on hinge on a JS timer.** Use carStore
   position ticks — the background feed keeps them flowing while locked.
7c. **Diagnose this class with the framework's own log, not by reading code.**
   `xcrun simctl spawn <udid> log stream --predicate 'processImagePath CONTAINS "Hairpin"'`
   prints `Template did push/pop, stack count: N` and `Requesting present template <...>`.
   Stack depth > 1 at rest = the map is covered. Three rounds of plausible code-reading
   failed to settle this; one log line did.
8. **Colours must go through `processColor()`** — `RCTConvert UIColor:` rejects hex strings
   and silently yields nil.
9. **A native event with no entry in the template's `eventMap` never reaches JS.** That was
   pinch-to-zoom: native emitted, no listener registered.
10. **Crash-gate every change** (`launch` → 20s → still alive) before it goes near the car.

---

## 6. Data flow

- **Crew** — `map.tsx` pushes the presence-merged `peerList` to `carStore` on a 2s interval,
  skipping unchanged coordinate-rounded signatures. The legacy REST/WS write in
  `ConvoyCarPlay` is fallback-only (never empty, never overwrites presence).
- **Presence budget (2026-09-25)** — Supabase Realtime lets one client send at most **5 presence
  updates (`track` + `untrack`) per 30 s, per connection**, and shuts the channel at the 6th
  (`ClientPresenceRateLimitReached`). The old 1.5 s throttle tripped it every 10.0 s while driving
  (268 in Jeff's 09-25 09:19–10:06 PDT CarPlay drive); every close cleared `live`, so the Crew pill
  (phone + head unit) blinked grey and the crew saw the driver drop out. Jeff: *"something happened to
  the green crew pill on phone/carplay top center its not green anymore"* — he chose **"Keep rule + fix
  drops"**: green still means another member's presence is live now. `src/presenceHub.ts` holds ONE
  hub-global rolling budget (all topics, never reset on a rebuild): ≤ 4 position tracks per 31 s and
  ≥ 7.5 s apart, the 5th slot reserved for priority sends (status / appearance / `src` live↔car-spot
  flips, the post-SUBSCRIBE track incl. supabase-js auto-rejoin, `untrack`); excess positions are
  dropped, a held priority send is flushed by one timer. The budget runs on `performance.now()`
  (monotonic), never `Date.now()` — a wall-clock correction must not reopen the server's window.
  `src` is derived during render in `useConvoyPresence` and is an effect dependency: walking away from
  a just-unplugged car moves only the live fix, and that flip alone must send the car spot. Crew
  positions over presence therefore move ~every 8 s (1 Hz fixes) instead of ~2 s. Gate:
  `tools/sim-qc/crew_online_test.mts` B0–B7, C0–C3 (clock), H1–H3 (the hook), K1–K3 (the cold car
  service). Telemetry: `crew-presence live= greyMs= drops= maxN= topic= ghost= sent= dropped=`, ≤ 1 row/min.
- **Route/ETA** — warm: the phone mirror. Cold: `navNotification`'s banner engine off
  `paceSPerM`. The mirror must not clobber the cold values (rule 6).
- **Position** — priority-gated feed (mirror > fg watch > bg task), staleness 2.6s.

---

## 6b. Start paths — cold / warm / crash / mid-drive

The surface must mount identically however the session begins. Three of the four were always
fine; the CRASH path was not.

| path | what happens | state |
|---|---|---|
| cold (phone app never opened) | `carPlayBootstrap` sets the idle root at module scope | OK |
| warm (phone app open) | `ConvoyCarPlay` owns the root (`carPlayHookOwnsRoot`) | OK |
| mid-drive connect | `registerOnConnect` → `onConnect()` | OK |
| **crash while connected** | **iOS re-activates the scene WITHOUT re-delivering `didConnect`** | **fixed in the plugin, needs build 68** |

Reproduced in the sim: normal launch → 3 `Setting root template`; **SIGKILL + relaunch → 0,
and zero `carplayframework` activity**; graceful quit + relaunch → 3. Run 3 proves the CarPlay
display was still live, so it is the crash path specifically.

RNCarPlay never learns the interface controller, `RNCPStore` stays disconnected, and JS's
`checkForConnection()` poke cannot recover it — that native method early-returns on
`!isConnected`. **No JS fix exists.** `CarSceneDelegate.recoverCarPlayIfNeeded()` now runs on
`sceneDidBecomeActive` / `sceneWillEnterForeground`: if this process holds no car window it
never got a `didConnect`, so it connects from the scene itself. Self-guarding on the weak
`carWindowRef`.

**The connect poke is now bounded to 60s** (re-armed on AppState-active / disconnect). It used
to run every 3s forever on every phone that never connects to CarPlay.

---

## 6c. After the disconnect — location privacy (LOCKED, Jeff 2026-09-25)

> Jeff, 2026-09-25: *"i think the connection is following me after the carplay dissconnect. it should not follow
> me when i discconect from car play... this is a privacy concern. fix it and lock it."* What followed him:
> *"My icon moved on the map."*

**The rule: once CarPlay / Android Auto disconnects, Hairpin runs no GPS watcher or location stream unless the app is
open on the phone or the phone is navigating — and the shared position and the marker stay pinned at the car until a
head unit reconnects or the phone provably drives away.** Exactly one thing still reaches the app after a disconnect
with the app closed: iOS **visit** events (`src/visitMonitor.ts`, CLVisit monitoring, always on since it was added —
not changed here). A visit can wake the app and POST `/location`, but what it posts is `shareablePositionAsync(null)`:
the car spot or nothing, never the visit's own coordinate (the server does see a fresh `last_seen`).

What was measured (crash_reports): fresh car-store fixes for minutes to hours after `carplay-disconnect` +
`loc-bgsess op=stop` (09-23: 110 min and 2 h 09; 09-25: 10:08→10:14), raw walking coordinates in
`draw-cmp surf=car` / `cam-apply surf=car`, two `nav-loc src=car` rows in the same second at every connect, and at
10:13:10 one 26 km/h fix while walking that armed the driving latch and un-pinned him (`latch=0→1 hu=1→0`).
Review 2026-09-25: on iOS a COLD CarPlay drive (the phone app never opened) was never witnessed at all — Rodrigo
poi7m7-227888 `draw-cmp … latch=1 parked=1 hu=0` 282 s after `carplay-disconnect`.

| mechanism | fix | gate |
|---|---|---|
| The car GPS watch started twice per connect (guard before the await, assignment after it); `stop` reached one, the other ran on with background delivery | `src/carFeedOwner.ts` is the ONLY creator: single-flight start, stop removes every subscription with no delivery needed, a fix arriving with no lock holder removes its watch and is dropped | `tools/sim-qc/car_feed_leak_test.mts` A–E, G (G0 reproduces the leak on the pre-fix `navNotification.ts`; G6 = a failed background start) |
| map.tsx's phone watcher: `sub = await watchPositionAsync(…)` lost a watch that resolved after cleanup; its background gate was never re-evaluated when a route ended | a `cancelled` flag + `removeWhenSettled` (also in the cleanup); `fgWatchKeep` = app active OR phone route OR head unit, in the deps; and a BELT that does not trust the raw head-unit flag (a lost Android Auto disconnect — didDisconnect and `op=hold on=0` both lost — would keep it true, and the watcher, forever): a delivery while the app is not active, with no phone route and no head unit by the privacy gate's TTL-bound `headUnitAttachedNow()`, removes the watch, drops the fix and logs `fgwatch op=self-stop why=no-car` (5 per process); the app returning restarts it. Cost: a backgrounded Android Auto session with no phone route loses this watcher 90 s after its one assertion — the car feed keeps the car map, odometer and privacy gate fed; only this watcher's `/location` fan-out stops (matters only with no active community) | `car_feed_leak_test` M (the effect extracted from map.tsx and run), F15–F16; M6 lost disconnect (M6-0 = 90dd1484's effect running on), M6b foreground restart, M6c a background route keeps it |
| iOS reported a head unit only from map.tsx, so a cold CarPlay disconnect was never witnessed and a cold connect never cleared yesterday's witness | `carPlayBootstrap` (the CarPlay session lifecycle) is a head-unit SOURCE and, once it has reported, the only iOS one; map.tsx is a fallback mirror that cannot create or cancel a witness; hydrate never adopts a witness while attached | `car_feed_leak_test` CP (the bootstrap run for real), `park_rearm_test` K |
| Android Auto: `AndroidAutoRoot` mounts once per JS process, so a SECOND car session in the same process never asserted a head unit, never re-took the lock, and its disconnect witnessed nothing (5 of 21 instrumented AA process lifetimes had 2–3 sessions); a JS context that JOINED a live session through a reload (red-pill Restart, ErrorRecovery) never ran the root at all (SMSGRC 09-20, 89u9bd: `op=hold on=1 via=init`, no root, the end witnessed by nobody); and a session destroyed while JS was cold-starting still got the root and `op=ctx`, i.e. an acquire with no release | the session lives at module scope in `AndroidAutoRoot.tsx`, keyed on CarJsKeepAlive's per-session hold receipt: it starts at `aaNativeTrace op=hold on=1` (any `via=`: acquire / join / regrab / init — init is a new JS context under a live session) and ends at `op=hold on=0` or `didDisconnect`, exactly once each; the mount starts a session only when native already reported the hold alive (or on a binary with no hold receipts, where the mount and `op=ctx` start it as before); the dead-man probe reads the same flag | `car_feed_leak_test` AA (the root module run for real against the real `locationPrivacy`, driven by the native receipt sequences): AA1–AA5 three sessions (AA0 = round 3's root); AA6 reload mid-session → witnessed (AA6-0 = round 4's root sharing the walk live); AA7 destroyed-before-JS → no acquire (AA7-0 = round 4's root: 1 acquire, 0 releases); AA8 init receipt before or after the mount; AA9 no receipts |
| At a relaunch, fast fixes that landed before storage resolved armed the latch and wrote `_carSpot`, so hydrate skipped the saved `hu=1` witness (Codex, reproduced); and a storage read that FAILED (rejected, or a record that does not parse) was still marked hydrated for the life of the process — the witness never adopted, one 26 km/h walking fix shared live and the record on disk overwritten (Codex final review; trigger HYPOTHESIS: an iOS background relaunch before the first unlock after a reboot, data-protected storage unreadable) | hydration is single-flight and counts only a SUCCESSFUL read (a missing key is a successful read); until then a fix may not arm the latch, write the spot or clear anything — only a head unit asserted now counts; a failed attempt is retried by the next caller, no sooner than 5 s after the last one started, and an attempt hung for 5 s no longer holds the flight; bounded `priv-hydrate ok=0/1 why=read/parse/apply/spot/empty` rows (5 per process). Codex delta review: while not hydrated a latch armed by a head unit's fixes still expires 90 s after its last driving fix, and `shareablePosition` shares live on fix evidence (`movingNow`) only once hydrated — a head unit attached now still shares live (an Android Auto TTL lapse with failing reads used to share the walk). Codex delta review 2: that decision is now SELF-SUFFICIENT — `movingNow` also requires the latch's last genuine driving fix (`_lastDrivingAt`) to be inside the 90 s window of NOW, computed at call time, so a caller that shares without feeding a fix first (map.tsx's manual refresh, visitMonitor, `shareablePositionAsync`) can never read a latch that only noteFix would have expired; a clock that moved backwards counts as expired; a successful hydration clears such a stale latch. Codex delta review 3: ONE pure predicate, `drivingEvidenceFresh(lastDrivingAt, now)` (recorded, not in the future, younger than 90 s), is used by noteFix BEFORE it reads or renews anything (a stale latch is expired first — a walking fix after a backward clock change used to renew it, write the car spot and be shared live; the first fast fix after a stale latch used to be recorded as the spot), by `shareablePosition`, `isParked` and the hydrate restore; Android's head-unit TTL (`carAttached`) treats a negative age the same way; a forward jump only ages evidence; the re-arm proof restarts on a large backward jump and counts nothing from before either jump. Audit of the other exported readers: `isParked`, `carAttached` (TTL) and the witness are computed at call time or fail toward pinned; `privacyDebug().latch` stays the RAW flag (telemetry); `headUnitAttachedRaw` is raw by design (UI, and map.tsx's phone-watcher keep-alive — a missed disconnect keeps that watcher alive, but it shares nothing: every outbound position goes through `shareablePosition`); every caller of `hydrateLocationPrivacy()` is released by the first of any attempt succeeding (one shared completion — a caller of a hung attempt is freed by the retry), its own attempt settling, or 10 s, and proceeds fail-closed if still un-hydrated (carDataService then joins presence; what it shares is `shareablePosition`'s call per tick) | `park_rearm_test` Y1/Y2/Y5, Y6 single-flight (Y0 = round 3 sharing live); HF1–HF4 reject once / reject 3× / unparsable twice / hang, each followed by fast walking fixes: never live, witness adopted by a retry, disk record byte-identical (HF0 = 0255f36a sharing live and overwriting it); HF5 backoff; HF6 a late hung read changes nothing; HF7 Android TTL lapse with failing reads never shares the walk (HF7-0 = 47db1aca sharing it), HF7b the sharing check alone (HF7b-0 = without it); HF8 the caller of a hung attempt released by the retry, HF8b by the 10 s bound, HF8c carDataService joins after the await (static) (HF8-0 = 47db1aca never releasing it); HF9 Codex's exact sequence through `shareablePositionAsync`, HF9b the same with no storage fault (HF9-0 / HF9b-0 = 7da32366 returning the walk); HF9c the clock moved back with walking fixes through noteFix, HF9d forward and back, HF9e a lost AA disconnect + a backward jump, HF9f the first fast fix after a stale latch (HF9c-0 / HF9e-0 / HF9f-0 = 90dd1484), V8 the re-arm proof across jumps (V8b-0 = without its restart) |
| After a witnessed park one fast fix re-armed the latch and cleared the witness; v2 of the proof then let two outliers + fast-reading walking un-pin; v3's SLOW congestion path un-pinned noisy walkers (88–189 of 200 with 8–12 m noise and 1 in 10 single-fix 15–18 km/h readings) and a phone sitting in a café 350 m away (167 / 200) | `src/parkRearm.ts` v4: jump rejection (a fix beyond max(2·v·Δt, v·Δt + 50 m) earns nothing and starts a new segment), credit only when the track covered ≥ 80 % of the claimed distance — each fix claiming speed × min(real Δt, 3 s) — over 10 s AND over its own fast run, median-of-5 endpoints; ONE path: 120 s / 15 s credit / 300 m net / 300 m from the spot (one constant, both floors; 250 m until round 5 — walking away from a witnessed park happens on every park, a phone-only drive-away after one is rare, so privacy wins: white-noise walker un-pins 329 → 95 of 7,200 for 26–27 s → 67–68 s on a 50 km/h drive with red lights). The slow path is removed | `park_rearm_test` V2–V7 (each defence alone; V5c / V6c / V7c = this rule with the real-Δt claim, the 10 s baseline or the run check undone), J, O, E, R, L, G, S, X, Z, WK (WK0 / WK6-0 = round 4 un-pinning the walkers and a moving-walkway concourse), Q (jams stay pinned; Q0 = round 4's slow path un-pinning one) |
| The drive's latch outlived the disconnect by up to 90 s, so `movingNow` shared any ≥ 9 km/h fix LIVE on it; a relaunch inside that window restored it over a witnessed spot | the witness drops the latch (`noteCarConnected`); hydrate never restores the latch over a `hu=1` spot, and adopting one drops a racing latch | `park_rearm_test` W, H2, S2 |
| Car-surface telemetry rows kept printing coordinates after the disconnect (CarMapView stays mounted) | `drawTelemetry.setCarSurfaceLive` (set only by `carPlayBootstrap` and `AndroidAutoRoot`); every coordinate-bearing car row — draw-cmp, pose-fix, corner-trace, snap-mode, cam-apply (`reportCamApply`) — is emitted from `drawTelemetry` only | `car_feed_leak_test` T; trap-check `car-row-outside-drawtelemetry` |

**⏱ The privacy clock (Codex delta review 4 — the clock class, closed).** Every in-process privacy window — the Android
head-unit TTL, driving-evidence freshness (`drivingEvidenceFresh`), the 90 s hysteresis, the re-arm proof's windows, the
hydrate backoff, the save throttles — is measured on `src/privacyClock.ts` `privacyNow()`: elapsed time that never runs
backwards. Each read advances it by the monotonic `performance.now()` step plus every SLEEP the wall clock saw and the
monotonic clock did not: the wall's excess over the monotonic step (Δwall − Δmono) is CARRIED across reads, floored at
zero, and counted in full once it passes 1 s (`SLEEP_EXCESS_MS`). So a sleep counts even if the monotonic clock pauses
(HYPOTHESIS per platform, unmeasured), a string of sub-second sleeps adds up (CLK3b), and a rollback hidden inside an
AWAKE gap — the clock set back by R during a gap longer than R, so no read ever sees a backward step — is forgotten
instead of swallowing the next R of sleep (round 12, the lead's C3/C4: round 11's max(Σ monotonic, Σ forward wall)
carried it as a debt for the life of the process, a later 10 min sleep counted 0 s, a lost Android Auto attachment
stayed alive and a walk was shared live for 89 s — a phone-only park's jog for 120 s; `park_rearm_test` CLK3, HF11,
HF12, with HF11-0 / HF12-0 / CLK3-0 = d72b0ae8's clock). The carry telescopes — it is the wall-minus-monotonic offset
now less its lowest value since the last count — so the clocks' different granularities cannot drift it (round 11:
summing max(Δmono, Δwall) per read ran 1.70× fast at 0.3 ms spacing, and at 1.25× a real car's re-arm could never prove;
CLK1, CLK1b ≤ 1 %). A read with no usable monotonic step (missing, throwing, NaN, behind its last reading) advances by
the wall's forward step alone (CLK4). A wall clock that jumps forward more than a second ages everything, and one set
BACK by more than a second adds an hour, closing every window, and logs a bounded `priv-clock-back by=<s> n=<k>` row
(5 per process; CLK2). An expiry is therefore irreversible until a NEW event
(an assertion, a vehicular fix under the latch rules, a proven re-arm). The wall clock is kept only for what is written
to disk (the spot's `t`, `LAST_DRIVING_KEY`), converted once at hydrate with future-dated or too-old stamps restoring
nothing. The car-feed settle rule uses plain monotonic time (`carFeedOwner.settleNow`, and map.tsx's `subAt`), whose
safe direction is "wait". Cost: a rollback expires the drive's latch (it re-arms on the next vehicular fix) and restarts
a re-arm proof in progress (`park_rearm_test` PTd: +42 s instead of +35 s). Gates: `park_rearm_test` HF9g (Codex's
rollback INTO the attachment window; HF9g-0 = b286ad9b reviving it), HF9c–f, PTa/PTb/PTc (30 seeds × 10 min each of
random device-clock jumps ±1 h / ±24 h / ±1 min / −2 min / −30 s, sometimes several at once: no live walking share and
no spot write after a witnessed or a lost disconnect; a real drive stays live on every fix; PT-0 = b286ad9b leaking on
5 of 30), PTd; `car_feed_leak_test` S1.

**The witness is not the pin (round 11).** At hydrate the persisted record's age, its speed and the driving stamp decide
only whether the PIN is shown; the witnessed park is restored from the record alone, with no date in the decision:
`hu=1` (a disconnect was heard) or `att=1` (the car feed was attached at the last save and no disconnect was ever seen —
the process died mid-drive) restores it unless a head unit is attached now. It used to ride on pin adoption, so a park
older than 24 h (or a device clock moved a day forward) and any iOS process death mid-CarPlay came back unwitnessed and
one 26 km/h walking fix shared the walk and wrote it as the spot (`park_rearm_test` HF10a–c; HF10a-0 / HF10c-0 =
36c17f1e). Cost: after such a relaunch a phone-only drive pays the re-arm proof (HF10d: +35 s).

**Documented residuals (privacy, 2026-09-25 — anything later that is not a NEW class joins this list):**
1. GPS alone cannot tell slow traffic from a noisy brisk walker or drift (0–20 / 200 per white-noise canyon set;
   σv 2–3 m/s walkers, runners, cyclists, buses, trains un-pin) — the fix is the build-80 motion-activity item below.
2. Slow congestion (under 300 m per 2 min) stays pinned until traffic speeds up or a head unit reconnects.
3. A LOST Android Auto disconnect (didDisconnect and `op=hold on=0` both lost) keeps the car feed (the 'androidauto'
   lock) alive: its dead-man probe reads the same session flag. Needs a liveness signal that survives both being lost
   (the phone watcher has its own belt, above; the privacy gate uses the 90 s TTL).
4. After such a lost disconnect, IN THE SAME PROCESS, the park is unwitnessed: once the TTL lapses, the ordinary
   one-fast-fix rule applies. (After a relaunch, a last save made while attached — `att=1` — now restores a witness.)
5. While storage reads keep failing, a drive after the Android TTL shares the head unit's last spot, not live.
6. A device-clock rollback costs a drive its latch until the next vehicular fix and restarts a re-arm proof (PTd).
   Measured on the lead's scripts (round 11): steps of −2 s every 30 s, or −5 s every 45 s or less often, leave a
   witnessed-park drive-away at +31–32 s; −5 s every 30 s delays it to +56 s. Accepted.
7. The parked-heading tracker (`carSpotTrust.headingTrackStep`) stays on wall time — it chooses the marker's facing
   only, and its observation is restored from the spot's persisted `t`.
8. JS cannot guarantee native GPS teardown (expo-location start/remove race) — the build-80 native item below.
9. Not verified on a device or a head unit (below).
10. A device-clock ROLLBACK and a sleep with `performance.now()` paused INSIDE THE SAME interval between two
    privacy-clock reads (the rollback during the sleep, or while the app is suspended around it): that interval's two
    steps cancel up to the rollback's size of the sleep, both clocks agree on a short interval, and a lost Android Auto
    attachment can look alive for the rest of its 90 s — a walking fix shared as "attached" (`park_rearm_test` KF1a
    pins it; KF1b bounds it: the revival ends within the remaining counted 90 s — 20 s in the model). JS cannot see it
    with two clocks that both lie. (A rollback in one interval and a sleep in a LATER one is NOT this residual: closed
    in round 12 — CLK3, HF11, HF12.) Build 80 (native): expose a
    boot-time clock that counts sleep — Android `SystemClock.elapsedRealtime()` (CLOCK_BOOTTIME), iOS
    `mach_continuous_time()` — and use it in `privacyNow()`. Trigger HYPOTHESIS (whether performance.now pauses in sleep
    on each platform is unmeasured).

**Receipt for the Android Auto cold-start guard** (the mount starts a session only once native's hold receipt said
"alive"; SELECT by the lead, 2026-09-25): across the 21 Android instances on runtime 1.29.0 in 14 days that logged
`aa-native op=ctx`, 21 / 21 also logged `aa-native op=hold on=1` in JS — 0 `op=ctx` without a hold — including all 8
car-started cold boots (`op=ctx` within 5 s of instance start); 8 instances logged `via=init`. So the receipt the
guard waits for does reach JS on a cold boot. Still no head-unit bench receipt for the guard itself (a session
destroyed during a cold start: `op=ctx` with no hold and no `aa-session op=start`).

`scripts/trap-check.py` rule `watch-assigned-after-await` flags the orphan shape where it is spelled
`= await Location.watchPositionAsync(` in `src/` and `app/` (text, not calls: an alias or a different location API
would pass it — `car_feed_leak_test` F17b forbids a named import of `watchPositionAsync`, F18 inventories the creators).
The values in `src/carFeedOwner.ts` and `src/parkRearm.ts` are pinned by `car_feed_leak_test` P1 and
`park_rearm_test` V1 (those files are outside `nav-lock.json`; the lock tool cannot add a file today).

Every release writes `loc-release tag=<t> fgLive=<n> task=<0|1>` (bounded, reliable): the field receipt after a
drive is `carplay-disconnect` → `loc-release tag=carplay fgLive=0 task=0` → no `loc-src feed=fg`, no fresh
`draw-cmp surf=car` until the app is opened. Phone-only navigation still tracks in the background by design (the
`nav` consumer), and so does the phone watcher while a head unit is attached (a second route started from the car).

Consequences, accepted and privacy-favouring:
- a CarPlay / Android Auto unplug **mid-drive**, or a drive away from a witnessed park without a head unit, shares the
  old car spot (and pins the marker there) until the re-arm proof or a reconnect. MEASURED at 1 Hz with 3 m noise
  (`src/parkRearm.ts` header): 24–36 s pulling away (67–68 s at 50 km/h with a red light every 400 m), 64–87 s on
  stop-sign grids, 89 s in stop-and-go, 73–78 s in a 10–20 km/h crawl; at one fix per 2 s 26–94 s, per 5 s 50–120 s.
  Jeff's real 09-19 / 09-23 drive-aways (crash_reports) prove +109 / +146 s from the first recorded row, 6 / 9 s after
  the car passed 300 m. The 90 s parked STATUS label (`isParked`, `_lastDrivingAt`) is unchanged.
- **Slow congestion stays pinned (round 5, the safe direction).** A phone-only drive (no head unit reconnects) in
  traffic averaging under 300 m per 2 min (2.5 m/s, 9 km/h) keeps the shared position AND the driver's own marker
  pinned at the witnessed park until traffic averages above that for about 2 min, or a head unit reconnects: jams
  averaging 0.6–1.3 m/s never prove in 30 min (nor does stop-and-go with 10 s standing, 2.36 m/s on average), and the
  same jam clearing to 40 km/h goes live 27 s later (`park_rearm_test` Q1–Q4). The real fix is the build-80
  motion-activity item below.
- **The residual — GPS alone cannot separate slow traffic from a noisy walk.** Every walker set of the fifth review
  stays pinned (0 of 200: 1.4 m/s walks with 8 / 10 / 12 m noise and 1 in 10 single-fix 15–18 km/h readings at 1 Hz,
  2 Hz, 2 m filter and Lite cadence; walk 350 m then sit; speed invalid except the spikes; a moving-walkway concourse
  with up to 1 in 5 fast readings). Still un-pinned: brisk 2.0 m/s walkers or 1 m/s drift with WHITE 8–12 m noise
  (0–20 of 200 per set, 95 of 7,200 walks), walkers whose reported position wanders 240–360 m (drift σv 2–3 m/s:
  2–499 / 500), and runners ≥ 15 km/h, cyclists, buses and trains (24–77 s) — after which the car spot follows them.
- a cold iOS CarPlay drive now counts as head-unit attached, exactly like a warm one: shared live while connected,
  spots recorded with `att=1` and witnessed with `hu=1` at the disconnect — so, as on the warm path, a drive whose
  process dies before the disconnect leaves no adoptable pin (`unwitnessed-attached`).

**Build 80 (native, HYPOTHESIS until a bench receipt) — OS motion activity for the re-arm.** The discriminator GPS
lacks is the phone's own motion classifier: iOS `CMMotionActivityManager` (`automotive` with `confidence ≥ medium`) and
Android Activity Recognition (`IN_VEHICLE` via the Transition API). A native module would feed `locationPrivacy` an
"in a vehicle since t" signal; the re-arm would then require it (and could accept a slow jam at once — the fix for the
congestion consequence above), and a walker, runner or cyclist could never prove. The bench check that confirms it before any rule depends on it: log the
classifier alongside fixes on (1) a walk with the phone in a pocket and in hand, (2) a run and a bike ride, (3) a city
drive with a 5-minute jam, (4) a bus ride — and measure the lag from pulling away to `automotive`/`IN_VEHICLE` and the
false-positive rate on (1)–(2). Needs the Motion & Fitness permission on iOS and ACTIVITY_RECOGNITION on Android
(a permission prompt: placement per `src/permissionGate.ts`).

**Build 80 (native, HYPOTHESIS until a device receipt — Codex + review 2026-09-25) — GPS teardown.** JS cannot guarantee native
teardown: expo-location 19.0.8 `ios/LocationModule.swift` `watchPositionImplAsync` stores `locationStreamers[watchId]`
and starts `streamLocations()` in a detached `Task {}`; `removeWatchAsync` stops and NILS the entry. A remove that
lands before that Task runs lets `manager.startUpdatingLocation()` start a stream nothing tracks (and the JS
`remove()` is idempotent, so no second call reaches native). The JS side does what it can — neutralise at once,
remove on the first delivery, on the 1 s settle timer, and on every owner start/stop/live() call — but a young
subscription with frozen timers and no delivery waits. Fix in `patches/expo-location+19.0.8.patch`: serialize start
and remove per watchId (a `removed` flag on the streamer checked inside `streamLocations()` before
`startUpdatingLocation()`, set by `stopStreaming()`; or keep the Task handle and cancel it in `removeWatchAsync`), so a
removed streamer can never start. Receipt owed: a bench run that removes a watch within 1 ms of its start and checks
`CLLocationManager` is not updating. Separately (review, refuted as unreachable today): a watch from a previous JS
context survives an in-process reload; the reload paths are gated off while CarPlay / Android Auto or turn-by-turn
is live.

Not verified on a device or a head unit yet — the gates run the real modules in node with a fake expo-location.

## 7. Open / next

- **Route line touching the car, drifting off-route** — Jeff's next focus, not yet addressed.
- **Tap receipts are live** — every press logs `carplay-tap:<id>` to `crash_reports` and flashes
  on the pill. Query that table after the next drive: rows present = taps reach JS (our bug,
  OTA-able); rows absent while Jeff taps = the press dies in the native template layer (build).
- Headless Scout + comms on a COLD connect (build 68) — the mic gesture's only subscriber is
  `map.tsx`, so it's dead until the phone app has been opened.
- Mic arbiter (build 68) — expo-av allows one recorder; the loser's cleanup pauses the winner.
- `CPWindow.mapButtonSafeAreaLayoutGuide` (build 68) — replaces the hand-measured insets
  with Apple's real per-head-unit chrome rect.
- **Android Auto still fails to launch on build 67** (confirmed with the current OTA). The
  bridgeless port already shipped in 67 and did NOT fix it. Blocked on a stack trace: the
  `AACrashLog` black box is written into the patch and uploads via
  `src/androidAutoCrashLog.ts` on the next launch — it just needs build 68. Do not theorise
  further before that `crash_reports` row exists.
- **Pinch-to-zoom:** the COLD root had no zoom handlers at all (fixed + shipped). The rest of
  the chain is verified end to end — `mapDelegate = self`, native emits, eventMap entries,
  config types. If it still fails WARM on the head unit, the suspect is Apple's iOS-26 gating;
  untestable locally (carkitd crashes in the iOS 26 sim).
