# sim-qc — drive the app on the iOS Simulator and MEASURE it

Jeff, 2026-09-03: *"how can we gate all these changes so they do not come back when verified?
every error in nav seems to always be replicating."*

This is the field half of the answer (the static half is `scripts/trap-check.py`). It replays a
real drive on the simulator against the exact bundle about to ship and measures the two things
that kept regressing, in pixels:

* **the self car's on-screen size** — must be the same at every zoom (it was swelling up to 2×
  between whole zooms until the per-tick scale shipped, group `a1fd5e74`, 2026-09-03);
* **the gap between the car's nose and the route line** — must be ≥ ~20 pt at any speed
  (the line was ending on the roof on CarPlay until the cut was anchored to the drawn car).

It was built by hand on 2026-09-03 and then written down; every step below was run that day.

## One-time setup

1. `./scripts/sim-ios.sh` — Release build, installs on "iPhone 16 Pro" (iOS 18.6).
   The Xcode-MCP tap automation only sees iOS 27 simulators, so also:
   `xcrun simctl boot <iOS27-UDID> && xcrun simctl install <iOS27-UDID> ios/build/DD/Build/Products/Release-iphonesimulator/Hairpin.app`
2. Location permission (no dialog on the sim): `xcrun simctl privacy <UDID> grant location-always com.sw0rdfisch.convoy`
3. A logged-in session: copy `Library/Application Support/com.sw0rdfisch.convoy/RCTAsyncLocalStorage_V1/`
   from a container that is already signed in (`xcrun simctl get_app_container <UDID> com.sw0rdfisch.convoy data`).
   Never type a password into the sim — copying your own session between your own simulators is the way.
4. `python3 tools/sim-qc/inject_place.py <UDID> qc 49.13823 -122.59453` — a saved place the search sheet
   lists under SAVED (and RECENT once used). The app must be terminated while writing.
5. Debug readout: set `debugOverlays: true` in the settings file (same storage dir, the file named by the
   md5 of `convoy.settings.v3`) — the HDG/TRIM lines then appear as accessibility text the hierarchy dump can read.

## A run

```bash
python3 tools/sim-qc/route_wps.py 49.11242,-122.51990 49.13823,-122.59453 > /tmp/wps.txt   # the app's own route
tools/sim-qc/drive.sh <UDID> park 49.112431,-122.51989        # park at the origin, launch
#   → in the app: Search → SAVED "qc" → Start   (Xcode MCP DeviceInteractionSynthesize: `t x y` on the hierarchy hitPoints)
tools/sim-qc/drive.sh <UDID> go /tmp/wps.txt 15                # drive the route at 15 m/s (54 km/h)
tools/sim-qc/drive.sh <UDID> shot /tmp/nav_54.png              # screenshot (1206×2622 on the 16/17 Pro)
tools/sim-qc/drive.sh <UDID> go /tmp/wps.txt 30                # and again at 108 km/h
tools/sim-qc/drive.sh <UDID> shot /tmp/nav_108.png
python3 tools/sim-qc/measure.py /tmp/nav_54.png /tmp/nav_108.png
```

`measure.py` prints, per screenshot: car length in pt (dark body + silhouette), the nose→line gap in pt at
three green thresholds, and PASS/FAIL against the two invariants. The TRIM debug line (readable via the
hierarchy dump or by eye in the screenshot) gives the exact `lead`, `cut+`, `lag`, `proj` metres.

## Traps met on the way (so you do not meet them again)

* `xcrun simctl openurl … convoy://go?to=qc` shows the OS sheet "Open in Hairpin?" — it needs a tap, and
  even after Open the app logged no `deeplink` crumb on 2026-09-03. **Simulator-only:** Jeff ran
  `convoy://go?to=home` from Safari on his phone the same day and the route preview came up. Use the
  search sheet (or the "Heading to … Let's go" chip) on the sim.
* The route the sim drives MUST be the app's own route from the SAME origin, or the car is >60 m off the
  line, unsnaps, and the app reroutes — the "line through the car" that looked like a trim bug was that.
  `route_wps.py` fetches with the app's token + profile (`driving-traffic`); park at the origin, select
  the destination while stopped, then drive.
* `simctl location start` only moves the app if the app is already running and listening; a single
  `set` while parked is deadbanded (9 m) and ignored.
* The Claude Code iOS-Simulator MCP crashed on every call that day; the Xcode MCP
  (`DeviceInteractionStartSession` on an iOS 27 sim) tapped fine.
* **Xcode MCP tap grammar (2026-09-05, cost 15 min of guessing):** `interactionCommand` is a chain of
  single-letter commands — `t x y` tap, `d x y` double-tap, `drag x1 y1 x2 y2 [seconds]` swipe/scroll
  (`drag 200 720 200 200 0.4` scrolls a list DOWN one screen), `w seconds` wait, `r <button>` hardware
  button, `orientation <value>`, and a type-text command that must be LAST. Chain them in ONE call:
  `t 167 77 w 1.5 t 47 129 w 3 t 106 749` is Search → "Drive to qc" → Start. `swipe`/`s`/`scroll` are
  NOT commands. Sessions expire after ~3 min idle AND on every reinstall ("Session not found") — start
  a new one with a new identifier; the identifier you pass IS the session key. Deep links to a route
  registered with `href: null` (settings, hub, garage…) do nothing — Expo Router drops them from the
  linking config — so reach Settings through the logo menu (`logo-menu-btn` → Settings row) and scroll.
  The grammar lives in `/Applications/Xcode-beta.app/Contents/PlugIns/IDEDeviceInteraction.framework`
  (`strings … | grep components`), not in any skill file on disk.

## Corner-release gate (numeric, seconds)

```bash
node --experimental-strip-types tools/sim-qc/corner_blend_test.mts
```

Exercises `src/cornerBlend.ts` on eleven scenarios (2026-09-04): the four position-release traces (divided-highway GPS
jitter and a single 4° step must stay snapped, a parking-lot swing 16 m off must release, the same swing 4 m off must
not), plus the NOSE clamp cases from Olaf's 09-04 drive — E: the 05:52:56 post-corner nose (44° off course) must be
pulled inside the 20° cone; F: the 06:39:43 straight must not move position; G: all 16 clean corner samples pass
through untouched; H: 45° off at 10 km/h is ignored; I2: ONE bad course fix held across 3 s of renders must not move
the nose (the hold counts distinct GPS fixes, not frames); I3: the real sequence with ~1 Hz fixes still releases;
I4: a frozen course decays any active correction. The sim cannot cut corners, so this is the only automated check of that logic.

## Ribbon-lead pitch-compensation gate (numeric, metres)

```bash
node --experimental-strip-types tools/sim-qc/ribbon_lead_test.mts
```

Exercises the pitch compensation added to `src/routeTrim.ts` on 2026-09-04 (field report: Olaf's CarPlay ribbon
touched the self car at a 90 km/h highway chase pitch — `ribbon-trim surf=car z=15.76 lead=55` alongside `cam-probe
p=55-59`). Asserts pitch 0 reproduces the exact pre-change lead/fade (hard-coded, so it also gates the "existing
callers unchanged" contract), pitch 57° compensates the lead and fade by ≥1.8x, and the TRIM_MIN_M/TRIM_MAX_M rails
still bind with a pitch term in the mix. This is a HYPOTHESIS gate — it proves the arithmetic does what the
routeTrim.ts comment claims, not that the on-screen kiss is actually gone; that still needs a drive video read
alongside the `pitch=`/`leadDp=` receipt fields.

## Off-route storm gate (numeric, reroute count)

```bash
node --experimental-strip-types tools/sim-qc/offroute_storm_test.mts
```

Replays Olaf's 2026-09-04 parking-lot reroute storm (five reroutes in three minutes, every one
`streak=0 why=diverging`) against the pure decision in `src/offRouteGate.ts`. The replay is CLOSED-LOOP —
each reroute it grants re-snaps the line to the road the car left, which is the ratchet the field log shows —
so the model has to reproduce the failure before it is allowed to prove the fix: scenario A asserts the
un-gated logic still storms (5 reroutes, 9 s apart, against the field's 5 at 8–12 s) and that the gated logic
cuts it to ≤1. B asserts a real wrong turn at 40 km/h reroutes on the SAME TICK as with the gates disabled,
C that a car parked with the GPS scattering outward never reroutes (`held why=creeping`), D that the
missed-maneuver fast path still fires. A swap moves the LINE, not the car: the first version of this replay
modelled a swap as the car jumping back to 27 m, which counted the re-snap as 37 m of driving and armed the
travel gate for free — that bug is why A now checks the un-gated count too.

## Ribbon anchor gate (numeric, the cut's anchor on long drives)

```bash
node --experimental-strip-types tools/sim-qc/ribbon_anchor_test.mts
```

Jeff, 2026-09-05 after a four-hour CarPlay drive: "the route line is way too far away from the car". His
807 `ribbon-trim surf=car` receipts read `anchorOff` avg 417 m / max 1268 m and `lag` −249 m. The cut's
anchor search (`alongMOnPartition`, ±250 m window) was hinted by `fracDrawn × totalM` — a fraction measured
on the projection line applied to the ribbon's own partition; the two length bases differ by ~1 %, so the
hint drifts a percent of the distance driven, leaves its own window past ~25 km, the search returns the
window's far end (that IS the 400-odd-metre `anchorOff`), the >80 m guard rejects it and the cut falls back
to the wrong metre plus the lead. `src/ribbonAnchor.ts` (`anchorCutM`, pure, re-exported by routeRibbon)
never hints with a foreign fraction: last anchor on this partition, one global search to seed, fallback only
when the car is really >80 m off the line; receipts carry `hint=prev|global|fallback`. The gate rebuilds a
40 km road with a 2.2 % shorter projection line and asserts the old hint misses by ~670 m with the field's
400 m `anchorOff` signature, the new anchor is within 1 m cold and hinted, re-seeds after a swap, falls back
off-line, and never jumps to the return leg of an out-and-back 30 m away.

## Timer-starvation gate (numeric, liveness clock + off-route hold)

```bash
node --experimental-strip-types tools/sim-qc/timer_starve_test.mts
```

Gates `src/timerLiveness.ts` (2026-09-04/05 — "the car surface must keep working with the
phone locked and the app not open"). Two field measurements forced a three-axis model
instead of one "frozen" bit: Rodrigo's CarPlay drive had JS timers dead for ~5 min while
native location events kept reaching JS (off-route trips posted live every 8-9 s while the
15 s route-fetch abort timers fired 29-at-once, 176-307 s late); the architect's iOS 27 sim
lock (2026-09-05, 54 km/h) measured the OPPOSITE split — timers alive, rAF and location
dead. Part A drives `timerLiveness.ts` directly (it has no RN-only imports at the top
level, same reason `offRouteGate.ts` stays Node-runnable): a fresh heartbeat reads ~0, a
stale one reads starved past the 3 s receipt threshold, a new tick clears it with no latch,
the sim-only debug-force switch (Settings → Developer → Debug overlays → Force timer
starvation) reports starved regardless of the real heartbeat, and the rAF side-channel
(tumbling 5 s windows, bounded memory even under the measured 52,839 callback/s iOS
runaway) is asserted to move INDEPENDENTLY of the timer clock in both directions — timers
healthy while rAF is silent, and rAF alive while the timer clock independently reads
starved — because conflating the two axes is exactly what would have read the sim run
backwards. Part B is the off-route side of the same finding, against the REAL exported
`holdReason()` / `offRouteTick()` in `src/offRouteGate.ts`. The first design was a blanket
`timers-starved` HOLD; Codex adversarial review (2026-09-05, pass 2) rejected it — timer
silence does not establish that a request cannot settle, and it would have disabled
off-route recovery for the whole locked interval — so it was replaced by request-lifecycle
bounding in `src/nav.ts` (GATE 4: ONE reroute in flight, aged and aborted off LOCATION
FIXES, `held why=inflight`). Part B asserts that contract: a young in-flight request holds,
an EXPIRED one never does (a stuck request must not wedge the gate), `null`/unmeasured never
holds, an existing `moved` hold is untouched, `inflight` is reported first, and — the Codex
objection made executable — a missed turn with timers reported starved by Rodrigo's worst
figure and nothing in flight TRIPS. `offroute_storm_test.mts` L/M/N are the same contract on
full traces (Q, 2026-09-05 22:50: a reroute the driver never joins — its line starts on a road he already
left — must re-trip on the 150 m post-swap arm, +37 s at 15 km/h and +6 s at 108 km/h; before, the trend flag held EVERY path
until the car came within 25 m of the line, i.e. never: Rodrigo's `held why=trend … since=25s`; Rodrigo's 29-request storm → 19 asks at 16 s gaps with one TRACKED at a time — a
rate-and-ownership bound, not a physical count: if iOS ignores `abort()` all 19 stay live on the
wire, which is why an aborted request never returns a route; a wrong turn with timers frozen
trips on B's exact tick; a hung ask retries every 16 s, never sooner), and they
drive the REAL slot — `src/rerouteSlot.ts`, the pure state machine `src/nav.ts` wraps — not a
mirror of it (review 2026-09-05: the first draft kept its own `outstanding[]` and would have
passed with the registry deleted). Scenario O is the slot's contract clause by clause (claim
ticket one-shot and dropped on an early return, identity-checked release, sweep frees + cancels
the request's own timer + aborts exactly once, nav end frees without aborting). What no Node gate
can see is the nav.ts WIRING — the sweep running before the decision and `rerouteInFlightMs`
being passed, the ticket armed around `onOffRoute`, both fetches claiming before their first
`await`, the wrapper forwarding to the pure module, and aborted results being dropped — so
`scripts/trap-check.py` carries seven rules for exactly that, each proven to fire on the
matching mutation the day it was added.

## Speed-episode gate (numeric, sounds per speeding stretch)

```bash
node --experimental-strip-types tools/sim-qc/speed_episode_test.mts
```

Gates `src/speedEpisode.ts` (2026-09-05 — Jeff: *"there is a single speed ding and a double ding
happening, and when I go 20 over and speed up it dings, then I speed up more it dings — really
annoying"*). The old `map.tsx` logic (per-threshold `armed` flags re-armed the instant the speed dropped
under the line, cooldown OR'd with the flag) is transcribed verbatim inside the gate and must reproduce the
complaint first — 3 sounds on Jeff's profile, 20 on a two-minute 20↔23-over wobble, a re-fire every
5 minutes while sitting at 25 over — before the real `speedEpisodeTick` is held to ONE alert per speeding
episode: A Jeff's exact profile (25 over 30 s → 45 → 25 → 45) → one single + one double; B the wobble → one
sound; C a 10 s dip under the limit → same episode, nothing; D 25 s under limit+5 ends the episode and a
fresh crossing after the 5-minute ceiling is episode 2 with its own single; E the ceiling never ADDS a
sound (three episodes in four minutes → one; 20 minutes at 25 over → one; a double also stamps the tier-1
clock); F unknown speed / limit → nothing, state untouched, and unknown ticks mid-episode neither end it
nor sound; G a launch straight to 45 over → the double only; H the exit dwell is CONSECUTIVE (one tick at
limit+5 resets it); I the adaptive tier-1 threshold gates entry while the exit line stays at limit+5.
Proven to fail on three mutations the day it was added (tier-2 once-per-episode guard removed, dwell 0,
cooldown re-fire inside an episode). What it cannot see is the `map.tsx` wiring (the `< 5 km/h` no-op
tick, the adaptive threshold, the `speed-alert tier= … episode=` receipt) and `src/speedDing.ts`'s
one-chime-at-a-time merge — those are read-verified, not measured.

## Arrival line gate (text, order)

```bash
node --experimental-strip-types tools/sim-qc/arrival_line_test.mts
```

Gates `src/arrivalEndings.ts`, the ONE arrival utterance (2026-09-05, Jeff: *"Nova also says the destination
name AFTER telling the weather on arrival. It should say 'You have arrived at <saved place name>. The weather
is 19 degrees right now.' Then add a series of endings"*). The receipts from his 20:36 PDT arrival showed the
line heard before the 18-char arrival line was the final-leg prepare callout (`tts-say len=45 → tts-play
len=50` = "In 50 m, you will arrive at your destination." after `m→meters`), not weather — nothing spoke
weather at arrival; it now rides the arrival line itself. The gate pins: place → weather → closer order on
every context and random pick; the no-label form ("You have arrived."); the no-forecast form (no weather
sentence, never "undefined"/"NaN"); every context (home / work / custom / sunny / rain / snow / cold / hot /
night / long / generic) yields a non-empty closer carrying its tag; 20 consecutive picks in one context never
repeat back-to-back (a one-entry pool falls back to the generic set); no closer has a dash, an emoji or more
than 8 words; "Drive safe on the way back." never plays at home; Jeff's example composes exactly as
"You have arrived at Lake. It's 19 degrees and sunny right now. <closer>"; and the `wx=` / `ending=` receipt
fields on the `arrive-speak` row describe the text they ride with. Running under plain Node is the proof
the module has no react-native import (`nav.ts` composes through it; the cold/AA path gets the same form
without the weather sentence).

## Car-spot trust gate (numeric, adopt / refuse)

`node --experimental-strip-types tools/sim-qc/car_spot_trust_test.mts` — `src/carSpotTrust.ts`, the rule hydrate
applies before believing a persisted parking spot (2026-09-06, Say Phin: "Compass button puts me here but I'm not
there, I'm home" — `draw-cmp mode=pin hu=0 sep=1141m spotAge=25791s`; the spot was written from a 7 km/h fix the
instant the process died with Android Auto attached, and adopted seven hours later because it was fresh). Scenario
A replays her record and must be REFUSED (`unwitnessed-attached`); B–C2 keep witnessed parks, phone-only parks and
pre-change records adopted; D–E the age and shape rules; F which fixes may become a spot at all
(`SPOT_WRITE_MAX_SPEED_MS` = 1.5 m/s: 7 km/h no, 3 km/h yes). What it cannot see: the AsyncStorage round trip and
`noteCarConnected` itself — those are read-verified; the field receipt is `draw-cmp … spotDrop=<why>` on the
first launch after a drive the app did not see end.

## Pose-estimator gate (numeric, seconds)

```bash
node --experimental-strip-types tools/sim-qc/pose_estimator_test.mts
**Section X (2026-09-10, "how do the big 3 do the GPS?")** — the shipped default: gyro OFF, 1 Hz fixes, the
ROAD HEADING on. On the no-gyro path the heading is ONE eased, rate-limited value (τ 0.35 s, ≤ 60°/s) chasing one
target: the convex mix, by roadK, of the last course carried forward by the inferred turn and the road's direction —
`projectOntoRoute` hands in `roadHdg` (the line averaged over ±max(speed/2, 10 m) of arc around the projection,
Mapbox's `interpolatedCourse`) and `roadHdgAhead` (the same chord speed × 1 s further along, their predicted
keyPoints), and the estimator slides between them as the held projection ages. The fix never jolts the heading.
roadK fades as road and course disagree (15° → 45°) and where the line turns sharply ahead (20° → 60°), both only
while the newest fix carries a course; a qualified course from the NEWEST fix > 45° from the road releases nose and
lateral pull (hysteresis 30°); an implausible uncorroborated chord step is held one fix or refused beyond 90°.
Every case is swept over 60 noise seeds against the same runs with the road stripped (`noRoad` = the eased course
path), p90 bars: course-dropped corner 51.8° vs 94.0° (the course path snaps 94° when the course returns — this
morning's field row); roundabout r=15 20.7° vs 30.8°; 50 km/h 27.1° vs 37.1°; 100 km/h 5.8° vs 17.9°; a straight
with ±8° course noise 0.4° vs 6.1° and 2°/s of swing vs 26 (THE WAG BAR); the one-vertex 15 km/h corner 39.4° vs
35.5° at 3 m and 45.5° vs 35.5° at 6 m — neither better nor worse (a raw-fix projection reaches the exit leg a
second early; Jeff's car-surface rows report 2–5 m); every exit leg within 0.4°; no swing above 60°/s anywhere.
R-tests: the release, the snap, the hysteresis edge, the wrong-leg refusal, a stale course cannot release, a
one-fix chord flip is held. The harness polyline is built like a real Mapbox line: one vertex at the tangent
intersection for arcs under 35 m (a residential 90° at 25 km/h is ONE vertex on the real line), a vertex every
5 m on roundabouts/hairpins, 20 m otherwise. Three refuter lenses + a 60-seed refuter shaped this section.

- `node --experimental-strip-types tools/sim-qc/fix_course_test.mts` — a fix's own course per platform: iOS keeps 0° (due north), Android drops 0 (`Location.getBearing()` = 0.0 with no bearing). Every feed site goes through `src/fixCourseHere.ts`.
- `node --experimental-strip-types tools/sim-qc/yaw_feed_test.mts` — the DeviceMotion → cumulative-yaw reducer (`src/yawFeed.ts`): fused attitude deltas on the SENSOR clock, cached re-dispatches are not new samples, freshness expires, the fallback rate path integrates at the sensor interval. Added 2026-09-10 with the wag fix.
- `node --experimental-strip-types tools/sim-qc/watch_taps_test.mts` — the wrist-tap rule (side from the maneuver key; prepare at a 12 s lead clamped 120–400 m; now at 40 m; one per kind per step; 1.5 s apart).
- `node --experimental-strip-types tools/sim-qc/watch_feed_test.mts` — the wrist payload: shape, on-change ≤ 2 Hz (nav on/off and step change immediate), 30 s stale rule.
- `node --experimental-strip-types tools/sim-qc/drive_feed_test.mts` — the drive-time location request (`src/driveFeed.ts`): BestForNavigation 500 ms / 2 m on every head-unit feed, High 1000 / 5 only under Lite GPS, and the rebuild rule that follows a Lite GPS toggle (or the settings hydration) onto the LIVE feeds — the Codex finding on OTA-AM, 2026-09-10.
- `node --experimental-strip-types tools/sim-qc/speed_limit_snap_test.mts` — the posted-limit snap (`src/speedLimitSnap.ts`): the road you are on runs the way you are going — a way more than 35° off the course while moving ≥ 3 m/s cannot be the road under the car (the Clearbrook overpass's 50 over the Trans-Canada's 100, Jeff's 09-10 09:01:55 double ding); one-way vs two-way; the 30 m tolerance; stopped/no-course keeps the old nearest-way rule.
```

Drives `src/poseEstimator.ts` — the continuous pose that replaced the snap / cornerBlend / cornerNose
switch stack for the DRAWN car during guidance (2026-09-09, Jeff: "why is it drifting and at low
speeds ... why cant this be fixed"). Scenarios: a left-then-right S-curve at 15 km/h with 1 Hz ±3 m
fixes and a 20 Hz gyro (position and heading measured on the SECOND corner, the first teaches the
gyro its sign), the same corner GPS-only, an opposite-sign sensor, a parked phone with jitter, a
lost signal (dead reckoning capped), a stale and a vague fix, a 1.5°/s gyro bias on a straight, and
Jeff's REAL King Rd rows from 2026-09-09 00:56:48–53 UTC — the corner that read 15.9 / 10.8 / 14.8 m
off the car on three drives. The gate holds the nose within 20° of the course at that corner where
the old draw pointed at the 124° polyline bisector, and the position within 8 m where the old draw
sat 14.8 m away on the line. Field receipts for the same numbers: `pose-fix` rows and the `est=`
fields on `corner-trace` / `draw-cmp` / `snap-mode`.
