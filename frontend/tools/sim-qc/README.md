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
