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
| map.tsx's phone watcher: `sub = await watchPositionAsync(…)` lost a watch that resolved after cleanup; its background gate was never re-evaluated when a route ended | a `cancelled` flag + `removeWhenSettled` (also in the cleanup); `fgWatchKeep` = app active OR phone route OR head unit, in the deps | `car_feed_leak_test` M (the effect extracted from map.tsx and run), F15–F16 |
| iOS reported a head unit only from map.tsx, so a cold CarPlay disconnect was never witnessed and a cold connect never cleared yesterday's witness | `carPlayBootstrap` (the CarPlay session lifecycle) is a head-unit SOURCE and, once it has reported, the only iOS one; map.tsx is a fallback mirror that cannot create or cancel a witness; hydrate never adopts a witness while attached | `car_feed_leak_test` CP (the bootstrap run for real), `park_rearm_test` K |
| Android Auto: `AndroidAutoRoot` mounts once per JS process, so a SECOND car session in the same process never asserted a head unit, never re-took the lock, and its disconnect witnessed nothing (5 of 21 instrumented AA process lifetimes had 2–3 sessions) | a session starts at the mount OR at the native per-session connect receipt (`aaNativeTrace op=ctx`, emitted only by `CarPlayModule.setCarContext` for a real session — never by the spurious `checkForConnection`) and ends at every `didDisconnect` and the unmount; one acquire, one release per session | `car_feed_leak_test` AA (the root run for real through 3 sessions against the real `locationPrivacy`; AA0 = round 3's root sharing the walk live) |
| At a relaunch, fast fixes that landed before storage resolved armed the latch and wrote `_carSpot`, so hydrate skipped the saved `hu=1` witness (Codex, reproduced) | hydration is single-flight; until it resolves a fix may not arm the latch, write the spot or clear anything — only a head unit asserted now counts | `park_rearm_test` Y1/Y2/Y5, Y6 single-flight (Y0 = round 3 sharing live) |
| After a witnessed park one fast fix re-armed the latch and cleared the witness; v2 of the proof then let two outliers + fast-reading walking un-pin, and never proved in a slow jam | `src/parkRearm.ts` v3: jump rejection (a fix beyond max(2·v·Δt, v·Δt + 50 m) earns nothing and starts a new segment), credit only when the track covered ≥ 80 % of the claimed distance over 10 s AND over its own fast run, median-of-5 endpoints; FAST path 120 s / 15 s credit / 250 m net / 250 m from the spot; SLOW path (congestion) 600 s / 30 s credit / 300 m from the spot | `park_rearm_test` V2–V4 (each defence alone), J, O, E, R, L, G, S, X, Z, Q (X0 / Z0 / Q0 = round 3 un-pinning walkers and never proving a jam) |
| The drive's latch outlived the disconnect by up to 90 s, so `movingNow` shared any ≥ 9 km/h fix LIVE on it; a relaunch inside that window restored it over a witnessed spot | the witness drops the latch (`noteCarConnected`); hydrate never restores the latch over a `hu=1` spot, and adopting one drops a racing latch | `park_rearm_test` W, H2, S2 |
| Car-surface telemetry rows kept printing coordinates after the disconnect (CarMapView stays mounted) | `drawTelemetry.setCarSurfaceLive` (set only by `carPlayBootstrap` and `AndroidAutoRoot`); every coordinate-bearing car row — draw-cmp, pose-fix, corner-trace, snap-mode, cam-apply (`reportCamApply`) — is emitted from `drawTelemetry` only | `car_feed_leak_test` T; trap-check `car-row-outside-drawtelemetry` |

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
  old car spot (and pins the marker there) until the re-arm proof or a reconnect. MEASURED at 1 Hz (`src/parkRearm.ts`
  header): 24–31 s pulling away, 23–71 s on stop-sign grids, 52–103 s in stop-and-go, 4–11 min in jams averaging
  0.6–1.3 m/s (245 / 310 / 506 s noise-free, 287 / 462 / 654 s with 3 m noise). Slower fix rates are slower: at one fix
  per 5 s a grid takes 90–105 s and a noisy 16 km/h jam does not prove within 15 min. The 90 s parked STATUS label
  (`isParked`, `_lastDrivingAt`) is unchanged.
- **The residual — GPS alone cannot separate slow traffic from a noisy walk.** In the review's urban-canyon walker
  model (10 min, 500 seeds per variant) the rule keeps 1.4 m/s walkers with drift σv ≤ 1 m/s pinned (0–1 / 500; round 3
  un-pinned up to 298) but walkers whose reported position wanders 240–360 m with speed readings that follow the noisy
  track still un-pin (181–500 / 500), and runners ≥ 15 km/h, cyclists, buses and trains un-pin in 24–65 s — after which
  the car spot follows them.
- a cold iOS CarPlay drive now counts as head-unit attached, exactly like a warm one: shared live while connected,
  spots recorded with `att=1` and witnessed with `hu=1` at the disconnect — so, as on the warm path, a drive whose
  process dies before the disconnect leaves no adoptable pin (`unwitnessed-attached`).

**Build 80 (native, HYPOTHESIS until a bench receipt) — OS motion activity for the re-arm.** The discriminator GPS
lacks is the phone's own motion classifier: iOS `CMMotionActivityManager` (`automotive` with `confidence ≥ medium`) and
Android Activity Recognition (`IN_VEHICLE` via the Transition API). A native module would feed `locationPrivacy` an
"in a vehicle since t" signal; the re-arm would then require it (and could accept a slow jam at once), and a walker,
runner or cyclist could never prove. The bench check that confirms it before any rule depends on it: log the
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
