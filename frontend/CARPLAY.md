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
│ [mic]        « N Crew · v67 · 1.19.0 »        [Search] [End] │  nav bar (system)
│                                                              │
│                                                              │
│  ┌────────┐                                                  │
│  │ 21°C   │  weather                                          │
│  └────────┘                                   ┌────────────┐ │
│  ┌────────┐                          🚗       │ ETA banner │ │
│  │  0     │  speedo                  car      ├────────────┤ │  ← car sits on
│  │ km/h   │                        (on the    │ turn banner│ │    THIS gap line
│  └────────┘                         gap line) └────────────┘ │
│                                                    (crew) ● │  map buttons
│                                                 (compass) ● │  (system, bottom-right)
└──────────────────────────────────────────────────────────────┘
```

**Top bar** — leading: comms mic. Centre: crew pill. Trailing: Search then End (End at the
far corner). *The trailing array is REVERSED vs visual order* — `[car-end, car-search]`
renders as "Search End". Head-unit verified; do not "fix" it.

**Bottom-right** — crew (upper) + compass (lower), a plain 2-button array.

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
| compass | CPMapButton | `compass` — recenter + face north, toggles, auto-releases on nav start |

Flow: `onMapButtonPressed`/`onBarButtonPressed` → `handleCarMapButton`/`handleCarBarButton`
(carActions) → `emitCarGesture` → `CarMapView`'s gesture subscription.

**Warm vs cold.** With the phone app open, `ConvoyCarPlay` intercepts some ids first and
calls live refs *directly* (never the bus) — don't hunt for a bus event on the warm path.
Cold falls through to the module-scope handlers.

---

## 5. Hard-won rules (each cost at least one bad build)

1. **NEVER add a hook below `if (!coords) return` in `map.tsx` (:2980).** Two crashes on
   2026-07-24. With no GPS fix the hooks don't run; when coords arrive the count changes →
   *"Rendered more hooks than during the previous render"* → surfaces as an opaque native
   abort with no JS frames. The crew feed lives at :1666 for this reason.
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
