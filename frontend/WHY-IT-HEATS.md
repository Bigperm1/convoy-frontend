All spot-checks pass. Every load-bearing claim below I read myself at HEAD 81f2a56.

---

# How Apple/Google/Waze do it, and what we're doing wrong

## 1. THE HEADLINE

**We compute the car's position and the camera in JavaScript, one frame at a time. Every other navigation app hands the map engine a destination and a duration and lets the engine do the in-between frames itself, on its own render thread.**

That single difference is why we need three expensive workarounds none of them need:

| Our workaround | Why it exists |
|---|---|
| Build 73's native `CADisplayLink` pump (60/sec) | JavaScript's clock dies when the phone screen sleeps, and our animation lives in JavaScript |
| `preventAutoLock: true` **by default** (`src/settings.ts:256`) — phone screen on for the whole drive | same reason, from the other end |
| An always-on 33 ms `setInterval` on **both** maps (`ConvoyMapbox.tsx:1054`) | a backup clock for the same JS loop |

A native engine needs none of these, because Mapbox's own render loop is already bound to the **CarPlay screen's** display link, not the phone's — verified, `MapViewDependencyProvider.swift:88`: `window.screen.displayLink(withTarget:selector:)`, with an explicit `window.isCarPlay` branch in `MapView.swift`. **Our own pump's source comment admits this** ("which is why the car map keeps DRAWING"). The pump exists purely to wake JavaScript.

**And the engine we're bypassing already does exactly what we hand-built.** Verified in `ios/Pods/MapboxMaps/.../Location/LocationManager.swift:184-201`:

```swift
puckAnimator = ValueAnimator(
    ValueInterpolator(duration: 1.1, input: onLocationChangeProxy.signal, …),  // position
    ValueInterpolator(duration: 0.3, input: onHeadingChangeProxy.signal, …),   // heading
    trigger: tracedDisplayLink, …)
```

1.1 s position ease, 0.3 s heading ease, driven by the map's own display link. Our `SelfCarModel` ease duration is `max(220, fixGap * 1.1)` — **we hand-wrote, in JS, the same 1.1× ease that ships in the SDK.** And `RNMBXCamera.swift:85-88` shows `easeTo`/`linearTo` map to `mapView.camera.ease(to:duration:curve:)` — a native animator. We explicitly opt out: `ConvoyMapbox.tsx:993-994` and `CarMapView.tsx:1681-1682` both pass `animationDuration: 0, animationMode: 'none'`, which falls to `mapboxMap.setCamera(to:)` — an instant state-set with **no interpolation at all**.

**Honest caveat up front:** this explains the *scripting* load, which I can count exactly. It does **not** explain the GPU load. We run **two complete map engines** (two `CoreMap`s, two Metal views, two tile pipelines — `MapView.swift:455`), and nothing gates the phone one (`map.tsx:3764` renders `<MapEngine>` unconditionally; zero hits for `allowUpdates` anywhere in `src/`). That doubling is real and **none of the fixes below remove it**. I have no measurement of the JS-vs-GPU split. Anyone who tells you which one is the heat is guessing.

**I make no claim about what Apple Maps, Google Maps or Waze do internally.** I did not read their code. What is *documented* is that every camera API they expose is declarative — `MKMapView.userTrackingMode = .followWithHeading`, `GoogleMap.followMyLocation(...)`, `animateCamera(update, duration, callback)`. Not one is a per-frame pose push. That's strong circumstantial evidence about the intended shape, not proof.

---

## 2. THE WORK BUDGET

**Assumptions (named):** rAF at 60 Hz · phone screen ON (keep-awake default) · CarPlay connected · navigating · highway speed, so the 6 cm/0.08° sub-pixel skip at `ConvoyMapbox.tsx:1164` never fires (at 100 km/h a 60 Hz frame moves 46 cm, ~8× the threshold) · GPS ~1 Hz.

| Work item, per second | Today | Could be |
|---|---|---|
| `step()` frame loops (phone + car, each its own rAF chain) | **120** | 0 |
| Native camera commits — JS `JSON.stringify` → bridge → Swift `JSONDecoder` round-trip, to move the camera 46 cm | **120** | **2** |
| React renders + Fabric commits of the self-car subtree | **120** | **0** |
| Full GeoJSON source replacements for a **one-point** feature | **120** | 0 |
| `CustomLocationProvider` location + heading pushes — fed into the SDK's own 1.1 s interpolator | **240** | **2** |
| `BridgeValue` allocations from the two `ModelLayer` style objects | **~16,200** | ~0 |
| `bgTimer` callbacks that hit the 150 ms heartbeat guard and return | **60** | 0 |
| `onCarFrame` native→JS events that hit the same guard and return | **60** | 0 |
| Full re-renders of the ~1,500-line map component (12 Hz trim ticker ×2) | **24** | ≤2 |
| Route-polyline `JSON.stringify` (10–116 KB each) | **24** | 0 |
| **GL contexts drawing at 60 fps** | **2** | **2 — unchanged** |

**~770 JavaScript-originated native operations per second → ~8.** Roughly a 100× cut in scripting work. The bottom row does not move.

**Two multipliers that could double the top block, both unverified:**
- `CADisableMinimumFrameDurationOnPhone: true` (`app.json:35`, `Info.plist:5`) and RN's display link sets **no** frame-rate cap (`RCTDisplayLink.m:32` — read it, it's the bare `displayLinkWithTarget:`). Meanwhile **both** MapViews are hard-capped at `preferredFramesPerSecond={60}` (`ConvoyMapbox.tsx:2800`, `CarMapView.tsx:1576`). **HYPOTHESIS: on a ProMotion iPhone our JS loop may be running at 120 Hz into maps that will only present 60 — every second frame's work is discarded before it's drawn.** Not measured. Cheapest check in this whole document (§6).
- All µs timings in the investigations were run under **Node/V8 on the Mac, not Hermes on device**. The *counts* above are exact and platform-independent; the *cost per count* on Hermes is higher by an unmeasured factor.

---

## 3. WHY 60 fps MADE IT WORSE

Build 73 doubled `link.preferredFramesPerSecond` from 30 to 60 in `HairpinSystemModule.swift:96`. For a native app that would double **drawing**. For us it doubled **scripting**, and the drawing didn't change at all:

- **The car map was already drawing at 60.** Mapbox's own display link is bound to the CarPlay `UIScreen` (verified above) regardless of our pump. Build 73 bought zero extra rendered frames.
- **What it doubled is `bgTick`** — and `bgTick` (`ConvoyMapbox.tsx:1040-1052`) does `pushCam()` + `setTick()` with **no sub-pixel skip**. `step()` has the skip; `bgTick` does not. So on a screen-off CarPlay drive, crawling or stopped, build 73 went from 30 to 60 unconditional full re-renders + camera commits per second, for pixels that are pixel-identical.
- **With the phone screen ON — the default configuration — all 60 events per second are pure waste.** rAF stamps `lastStepAtRef` every frame, so `bgTick`'s first line (`if (now - lastStepAtRef.current < 150) return`) bounces every one. 60 native→JS bridge crossings per second to do nothing.

A native app's frame rate is a **drawing** dial. Ours is a **JavaScript-execution** dial that happens to be labelled "fps". That is the whole regression.

---

## 4. WHAT WE GIVE UP — the protected features, plainly

Read this section before anything else, because the naive version of this fix ("just use the native puck") **would cost you three of the four things you're protective of**, and I am not recommending it.

| Feature | Under my recommended plan (§5 items 1–3) | Under the "native follow-puck" version |
|---|---|---|
| **3D car GLB model** | **Untouched.** Stays a `ModelLayer` inside a `ShapeSource`. | **LOST as-is.** `@rnmapbox/maps` only ever sets `.puck2D(...)` — verified, `RNMBXNativeUserLocation.swift:145` and `:195`, no `puck3D` anywhere, despite the Mapbox SDK supporting `PuckType.puck3D`. Getting the car onto the native puck needs a **patch + a paid build**. |
| **Green arrow** | **Untouched.** Same `ModelLayer` path (`ARROW_MODEL_ID`, `modelTranslation` +16 m lift). | Same loss as above. |
| **Heading-up chase cam** | **Untouched.** All framing logic (`camHeadingOverrideRef`, `lockReadyRef`, the CarPlay north-up hold) stays in JS — it just runs **once per GPS fix** instead of 60×/sec. | **At risk.** `RNMBXCamera.swift:220-242`: every `followZoomLevel`/`followPitch`/`followHeading` setter rebuilds a whole new `FollowPuckViewportState` and calls `viewport.transition(to:)`. Changing follow-zoom at 1 Hz restarts a viewport transition every second. |
| **Speed-based zoom / corner zoom-out** | **Untouched.** Zoom and pitch ride in the *same* camera stop and get interpolated natively over the same duration. Your `CAM_SMOOTH_TAU_MS = 1400` low-pass stays. | **At risk**, same mechanism. There is no native equivalent of that low-pass through rnmapbox's follow binding. |
| The parked dead-band (`SELF_DEADBAND_STOP_M`) | **Must move** from per-frame to per-fix. Same behaviour, applied at the input. Small, contained. | Lost — `FollowPuckViewportState` only has `.skipRepeats()` on bit-identical values, so parked GPS jitter would roam the camera. |

**The one genuinely new risk in my plan:** camera and marker must stay glued. Today one rAF loop guarantees it. Natively, the camera would ride `mapView.camera.ease(...)` (screen-bound display link) and the marker would ride `MovePointShapeAnimator` — whose `CADisplayLink` is **not** screen-bound (`ShapeAnimatorCommon.swift:88-90` uses the bare `CADisplayLink(target:selector:)` on `.main`/`.default`). Same duration, same endpoints, both linear → identical positions *if both links tick together*. **HYPOTHESIS, unverified: whether the shape animator keeps ticking with the phone display asleep on a CarPlay drive.** This must be measured before item 3 ships. It is exactly the marker-drift class from 2026-07-24.

---

## 5. THE PLAN — ranked, smallest risk first

**1 · Delete the pure waste. OTA. Zero visual change.**
- Gate the always-on 33 ms `bgTimer` on `carFramePump`, not `cameraRef` (`ConvoyMapbox.tsx:1058-1065`). The inline comment says "Phone instances (no cameraRef)" — **that comment is stale**; the phone passes `cameraRef` at `:3226`, so the phone map has been running a 30 Hz backup ticker its entire life. Saves 30 timer callbacks/sec.
- Memoize `routeFC` in `CarMapView.tsx:1469` (it's a bare object literal) and `handleRoutePress` in `ConvoyMapbox.tsx:2089`, so the 12 Hz trim ticker stops re-`JSON.stringify`-ing a 10–116 KB unchanged polyline 24×/sec.
- **Saves:** ~54 no-op ops/sec + 0.25–2.8 MB/sec of JSON churn. **Breaks:** nothing — these are provable no-ops. **Do this first regardless of everything below.**

**2 · Ship the instrumentation (see §6). OTA.** Nothing else should be decided before this reports.

**3 · Per-fix camera + native marker interpolation. OTA. This is the architectural fix.**
- Replace the 60 Hz `pushCam` with **one** `setCamera({centerCoordinate, heading, zoomLevel, pitch, animationDuration: fixGap, animationMode: 'linearTo'})` per GPS fix.
- `linearTo`, **not** `easeTo` — `easeTo` is `.easeInOut` (verified `RNMBXCamera.swift:86`), which would decelerate into and accelerate out of every fix: a visible per-second pulse at constant speed.
- Move the marker to `MovePointShapeAnimator.moveTo({coordinate, durationMs: fixGap})` at the same duration.
- Delete `step()`, `setTick`, `bgTick`, the rAF-stall watchdog, the sub-pixel skip. Move the dead-band to the input.
- **Saves:** ~700 JS-originated ops/sec and ~16,000 object allocations/sec. **Gains smoothness too** — today a JS-thread stall (route decode, WS message, React commit) *is* a visible camera stutter, because the pose is computed on that thread. Natively the map glides straight through it.
- **Breaks / risks:** the camera↔marker lockstep under a sleeping phone display (§4). Ship behind a debug toggle and A/B it in the driveway before it becomes the default.

**4 · Stop running two live engines. OTA.**
- Add a `dormant` prop to `ConvoyMapbox`: `preferredFramesPerSecond={1}` + skip the pose work + tear down the road-snap/water/trim tickers. **Do not unmount `<MapView>`** — that's the remount class that produced the CarPlay GL retry storm (223 retries/80 min).
- **Gate on "the phone display is actually asleep", never on `carConnected`** — the phone is a real second screen someone may be looking at.
- Also revisit `preventAutoLock: true` as a default. Two hours of a 3D map at full brightness in daylight is a thermal load before any of our code runs.
- **Saves:** one whole engine's GPU + tile pipeline in the screen-off case. **Breaks:** wake latency (mitigated by frame-cap-not-unmount); Android Auto behaviour here is **unverified** — rnmapbox binds the Mapbox lifecycle to view attach/detach (`RNMBXMapView.kt:1502,1525`), not Activity lifecycle, so the Android phone map may keep rendering behind an AA session. Measure on a head unit; this also touches the known AA location-lock leak.

**5 · Patch rnmapbox for `puck3D` + native follow. NEEDS A BUILD. The endgame — do not fund it before 2 and 3 report.**
- Wire `PuckType.puck3D` through `RNMBXNativeUserLocation`, feed `CustomLocationProvider` at 1 Hz, and let `FollowPuckViewportState` derive the camera from `onPuckRender` — car and camera lockstep **by construction**, at 60 fps, with zero JS per frame (`FollowPuckViewportState.swift:29-41`, read it, the camera literally comes off the same interpolated signal that draws the puck).
- Requires a real design answer for speed-zoom/pitch modulation (§4). That is the one part of this that is design work, not deletion.

**6 · Delete the build-73 CADisplayLink pump. NEEDS A BUILD — and only in the same build as 5, never before 3 is proven.** Its only consumer is the JS pose loop. Once nothing computes poses in JS, it has no consumer. But if item 3's shape animator turns out not to tick screen-off, the pump is still load-bearing — so this is last, not first.

**Not on the plan, ruled out:** sharing one map engine across both windows. One `CoreMap` is bound to one Metal view in one window (`MapView.swift:420-457`, display link recreated in `didMoveToWindow`). Mapbox offers a `Snapshotter`, not a shared live renderer. Stop looking.

---

## 6. WHAT WOULD SETTLE IT

The app reports **no temperature at all** today, and you can't order a tester to drive. So the measurement has to be hands-free and has to work in a driveway.

**Ship this OTA now (item 2 above). Three probes, all pure JS, all into the existing `logEvent` → Supabase `crash_reports` sink:**

1. **The rAF-rate counter.** Log `performance.now()` deltas inside `step()` for 5 seconds at nav start. **This is the single cheapest check in the document and it settles a 2× factor on every number in §2** — if rAF is at 120 while both maps are capped to 60, half of all that work is provably thrown away before it's drawn. Takes five seconds of the app being open, no drive.
2. **The thermal-throttle detector.** `expo-battery` is already a dependency and already wired in `src/powerMode.ts`. Sample `getBatteryLevelAsync()` + `getBatteryStateAsync()` every 60 s during nav, alongside `carConnected`, AppState, and the build/update id. **A drive where level is flat or falling while state is `CHARGING` is iOS throttling the charger — the exact symptom you saw, captured automatically, on every drive, from every tester, with no instruction.** That converts "it got hot that one time" into a per-build number you can compare.
3. **A frame-op counter** — count `pushCam` calls and `setTick` calls per 60 s window and log the totals. Turns §2's table from arithmetic into measurement.

**Then the decisive experiment, and it does not need a drive.** Ship a synthetic-fix replay behind the existing `debugOverlays` toggle (the codebase already has local test rigs). Sit in the driveway, engine off, CarPlay connected, phone in the mount, same brightness, 15 minutes each:

- **Run A:** stationary, real GPS. The sub-pixel skip fires; JS pose work ≈ 0; both GL contexts still drawing.
- **Run B:** synthetic 100 km/h fix replay. JS pose work at full rate; GL contexts identical.

**If B is hot and A is not, the JS pose loop is the load and items 3–4 fix it. If A and B are equally hot, the load is the two GL contexts plus the always-on screen, and no amount of JavaScript surgery will fix it — the answer is item 4 and the keep-awake default, not item 3.** That is the fork in the road, and right now nobody in this investigation — me included — knows which branch we're on.

**Add `ProcessInfo.thermalState` to `HairpinSystemModule` in whatever the next build is.** It's about ten lines, it's free once you're already paying for a build, and it's the only ground truth for heat. Just don't cut a build *for* it.

---

## What I am NOT claiming

- That any of this "fixes the heat." The mechanism is verified; the **magnitude is unmeasured**. Nothing here is an Instruments trace.
- That Apple/Google/Waze work the way I described internally. I read their public APIs and their integration guides, not their engines. Their SDKs' shape is evidence about intent, not measurement.
- That the phone map was actually contributing on your 2-hour drive. That depends entirely on whether your phone's display was on — and with `preventAutoLock` defaulting to true, it almost certainly was, unless you pressed the side button. **That's the one fact only you can supply, and it changes the ranking of items 3 and 4.**