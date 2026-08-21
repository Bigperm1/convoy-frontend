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

# Three-Route System + Greeting Flow — Design

Status: IN PROGRESS (approved scope: AI route = auto-learn; build top-to-bottom). Author: Nova/Claude, 2026-06-29.
- ✅ **P1** greeting fix — shipped (commit 392eb49).
- ✅ **P2** 3-route display on phone — shipped (commit 21ca9e3): Best/Scenic/AI line styling + Drive-banner chip selector, AI stubbed.
- ✅ **P2.5** 3-route on CarPlay — built: carStore mirrors display routes + selectedIndex; CarMapView draws them per-kind in preview with an extra zoom-out (the lockstep chase is untouched — no fit-to-bounds overview, deferred as a device-test item). Kind/color logic now a single source of truth (`routeKindFor`/`routeColorsFor` exported from ConvoyMapbox, used by both surfaces).
- ✅ **P3** AI-route memory subsystem — built (auto-learn):
  - `src/aiRoutes.ts` — local store (AsyncStorage `convoy.aiRoutes.v1`), distance-decimated trace per saved place, `recordDrive`/`matchAiRoute`/`viaPointsFor`.
  - Capture: `driveTraceRef` in map.tsx accumulates the whole driven path during nav; on arrival (or manual end) near a saved-place destination, the path is decimated + persisted.
  - Replay: `fetchMapboxRouteVia` (driving-traffic, via-waypoints, multi-leg concat, interior arrive/depart steps stripped) → `fetchAiRoute` returns a NavRoute tagged `kind:"ai"`.
  - Inject: the route-fetch effect appends the AI route (preview only) when the destination is a learned saved place and the origin is near the learned trace's start; deduped vs Best.
  - AI chip shows the learned route's live ETA, or a disabled "Learning…" stub for not-yet-learned saved places (hidden for one-off destinations).
  - Known v1 limits: last-good aggregation (no most-frequent clustering yet); background-only drives may have trace gaps (foreground GPS watcher). Both fine for the habitual-shape memory.

## Goal
When a destination is chosen (search / recents / saved), offer **three** route options, drawn together and styled distinctly:

| Slot | What it is | Line style |
|---|---|---|
| **Best** | Fastest by live traffic (Mapbox `driving-traffic`, alternative 0 by ETA) | User's route color (`settings.routeColor`) |
| **Scenic** | The alternate that diverges most from Best | A color contrasting the user's |
| **AI** | The user's *habitual* path to a saved place (Home/Work/custom) — learned from their drives, may not be fastest | **Black core, user-color casing (edges)** |

- All three visible on **phone + CarPlay** (camera fits all routes in preview).
- **Tap a route** → it selects + the Drive banner shows its ETA / distance / traffic.
- The **Drive preview banner** (the pre-Start surface) hosts a Best/Scenic/AI chip selector.
- On **Start**: greeting plays → finishes → guidance speaks **the next maneuver only** (not a full readout).

## Current architecture (verified)
- **Routing** is **Mapbox Directions `driving-traffic`** with `alternatives=true` (`src/mapboxDirections.ts:360`, via `nav.ts fetchRoutes:135`). Up to **3** routes already come back in `routes[]` — *Google is gone* (CLAUDE.md is stale). `NavRoute` carries `duration_s`, `duration_in_traffic_s/text`, `freeflow_s`, `distance_m/text`, `congestion[]`, `coordinates[]`, `summary`, `steps[]`.
- **Drawing** (`ConvoyMapbox.tsx:825,1306-1330`): all routes in ONE FeatureCollection tagged `properties.index`. Today only the **selected** route is styled (color casing+core); alternates get one flat gray layer. The `routes[].color?` prop field **exists but is unused** — we wire it.
- **Selection/tap** already works (`handleRoutePress` → `onSelectRoute` → `selectedRouteIndex`). The only per-route "stat" today is a time-only midpoint pill.
- **Pre-Start surface** = the **Drive preview banner** (`map.tsx:2397-2484`), NOT `StepDrawer` (which is nav-only, single-route). The chip selector + stats go in the Drive banner.
- **Zoom-fit**: phone already fits all routes in preview (`ConvoyMapbox.tsx:965-993`). CarPlay has **no** overview mode (mandatory lockstep chase) — needs a new preview camera.
- **Saved places** (`src/savedPlaces.ts`): local AsyncStorage, Home/Work singletons + custom, `matchSavedPlace` (160m). **No drive-path history exists anywhere** — `posHistoryRef` is an in-memory 30s buffer; `recentRoutes` is endpoints only. So the AI route's path memory is a **brand-new subsystem**.
- **Greeting two-voices bug (root cause found):** `playSpeedDing` **bypasses the queue and the greeting hold** (`map.tsx:690` → `speedDing.ts`, own `createAsync`, MixWithOthers) → a speed ding sounds *on top of* the greeting. Plus no hard lock at the playback primitive (`playBase64Audio`), so a re-entrant drain can start a 2nd clip.

## Phases (all JS-only / OTA-able — no native rebuild)

### P1 — Greeting fix (confirmed bug, smallest, highest value) — ships first, alone
**A. Hard single-playback guard** (kills the literal two-voices):
- Export `isAudioBusy()` from `nav.ts` = `_greetingInFlight || ttsPlaying || _currentSound != null`. In `speedDing.ts playSpeedDing`, early-skip when busy (the ding is non-critical; drop it rather than overlap).
- Add a module-level mutex around `playBase64Audio` (`nav.ts:878`): before `createAsync`, if `_currentSound` is set, stop/unload it (reuse `stopSpeech` teardown) so at most one clip is ever live. Makes "one clip at a time" structural, not advisory.

**B. Greeting → next-maneuver only:** the parked first callout (`nav.ts:432`) is currently a full readout (`"Starting navigation. {verb} {inst}. Total {duration}."`). Change to the **next maneuver only** (`"{verb} {stripDirections(inst)}"`), matching the in-drive guidance shape (`nav.ts:509-516`). Greeting plays → 1.2s pause → single next-turn line. (Trip-time stays in the *greeting text* so it's not lost.)

Files: `src/nav.ts`, `src/speedDing.ts`. OTA.

### P2 — 3-route DISPLAY on phone (AI slot stubbed/empty)
- In `map.tsx`, derive per-route `kind` ("best"|"scenic"|"ai") + `color`: Best = index 0, user color; Scenic = the alternate that diverges most (geometry / different `summary`), contrasting color; AI = empty until P3.
- Wire the dead `routes[].color?` field; add `properties.color`/`properties.kind` to `routeFC` (`ConvoyMapbox.tsx:825`).
- Replace the 3 LineLayers (`1308-1328`) with **per-kind data-driven styling** (`lineColor:["get","color"]`): Best/Scenic = casing(wide, color) + core(narrow, color); **AI = inverted** (wide casing in the USER color = the visible edges + a narrow **black** core). Keep the trim/congestion gradient on the *selected* route during nav only.
- **Drive banner selector** (`map.tsx ~2447-2463`): a horizontal Best/Scenic/AI chip row, each showing that route's ETA/distance/traffic + a color swatch, `onPress` → `handleSelectRoute(i)`, highlight selected. The summary block already reads `activeRoute`, so it auto-updates.
- Phone zoom-fit already includes all routes. OTA.

### P2.5 — 3-route on CarPlay (separate; needs a new camera mode)
- Extend `carStore` to mirror `routes[]` + kinds + colors + selectedIndex.
- Replicate the per-kind LineLayers in `CarMapView.tsx` (`259-280`).
- Add a **preview fit-to-bounds camera** that yields to the lockstep chase the instant nav starts (so it can't fight the proven chase cam). OTA, but isolated so a CarPlay regression can't block P2.

### P3 — AI-route MEMORY subsystem (the big one) — auto-learn
- **Capture:** on each completed drive whose destination `matchSavedPlace()`-resolves to a saved place, persist a **decimated** polyline of the actual driven path (from the nav fix stream the map already consumes; ~1 pt/50m or Douglas–Peucker).
- **Store:** new `src/aiRoutes.ts` (mirrors `savedPlaces.ts`: module cache + listeners + loadPromise), AsyncStorage `convoy.aiRoutes.v1`. Per entry: `{ placeId, encodedPolyline, drives, lastDrivenAt }`. Local-only (no backend). Aggregation v1 = keep last-good; most-frequent/cluster later.
- **Match:** when a destination resolves to a saved place WITH a stored AI route AND the current origin is near the trace's start → surface it as the AI slot.
- **Live ETA/congestion:** re-run the stored trace through Mapbox as **waypoints** (reuse `fetchRoutes`) so it returns a real traffic ETA + `congestion[]` → it becomes a normal `NavRoute` (all stats/gradient code reused) that just follows the habitual geometry.
- **Empty fallback:** never fabricate. No memory → AI chip shows a disabled "Learning your route" state (or hidden); show only Best + Scenic.
- **Learn threshold:** offer after ≥1 completed drive (tunable); strengthen to "most-common of last N" later.

## Decisions (defaults chosen; flag any to change)
1. **AI capture = auto-learn** ✅ (your choice).
2. **AI scope = saved places only** (Home/Work/custom) for v1.
3. **Scenic color = auto-derived contrasting hue** from the user color (rotate hue ~160°, vivid S/L) so it never collides with any route-color pick. (Alt: a fixed accent.)
4. **AI look** = wide user-color casing (edges) + narrow black core.
5. **<3 alternates** → hide the Scenic chip (no forced extra fetch in v1).
6. **AI ETA** computed lazily (when the AI route is selected) to limit Mapbox calls; cached estimate shown otherwise.
7. **Empty AI slot** = a disabled "Learning your route" chip (discoverable) — easy to switch to hidden.
8. **Greeting** keeps trip-time in its spoken text; the post-greeting turn line is maneuver-only.

## Risk / verify
All phases OTA (`eas update`), gate on `yarn typecheck`. On-device checks: P1 — speed ding never overlaps the greeting, greeting→single next turn; P2 — three distinctly-colored routes, tap selects + stats update, AI inverted style; P2.5 — three routes fit on the head unit, chase resumes at Start; P3 — drive to Home, confirm the path is learned + offered next time with a live ETA.
