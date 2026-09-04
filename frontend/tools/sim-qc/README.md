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

Exercises `src/cornerBlend.ts` (the marker's corner release) on four synthetic traces: divided-highway GPS jitter
and a single 4° step must stay snapped (blend 0); a parking-lot swing 16 m off the line must release (≈1); the same
swing only 4 m off must stay snapped. The sim cannot cut corners, so this is the only automated check of that logic.
