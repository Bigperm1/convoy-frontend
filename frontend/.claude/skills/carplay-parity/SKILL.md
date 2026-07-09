---
name: carplay-parity
description: Audit CarPlay ↔ phone HUD parity after any HUD/nav/map change — the standing rule that the CarPlay surface must match the phone (phone is the reference). Use after changing the phone HUD, or when asked "does CarPlay match?".
---

# CarPlay ↔ phone parity audit

**STANDING RULE:** every phone HUD change must be mirrored to CarPlay in the same OTA, and vice-versa. The phone is the reference. Jeff has had to ask for this repeatedly — treat it as an acceptance criterion, not a follow-up.

## Where things live
| Surface | Files |
|---|---|
| Phone HUD/nav | `app/(app)/map.tsx`, `src/components/TurnByTurnNav.tsx`, `src/components/StepDrawer.tsx` |
| Phone map | `src/ConvoyMapbox.tsx` |
| CarPlay overlays (banner, speedo, chips) | `src/carplay/ConvoyCarPlay.tsx` |
| CarPlay map/camera | `src/carplay/CarMapView.tsx` |
| Shared state bridge | `src/carplay/carStore.ts` (phone `map.tsx` is the writer) |
| Glass/tint helpers | `src/Glass.tsx` (`hudTint()`, `drawerTint()`), `carHudFloor()` in ConvoyCarPlay |

## The 5 parity dimensions (each has bitten before — check all)
1. **Tint/glass per map mode** — CarPlay chips must be map-mode-aware like `hudTint()`: dark wash on light basemaps (dawn/day/satellite), clear glass on dusk/night. Check `carHudFloor()` mirrors the phone's logic. (Note: true refractive Liquid Glass does NOT render on the CarPlay window — OS limitation; match tint/readability, not refraction.)
2. **Fonts + formats** — white text both sides, same km/mi distance formatting (`fmtManeuverDist`), same maneuver arrow (`ManeuverArrow` + `maneuverDir`, including roundabout exit angles), no double-"exit" (`cleanManeuverInstruction`).
3. **Camera** — same road-ahead feel: `CAR_ZOOM_OUT`, `CAR_PITCH_BONUS`, `CAR_LOWER_PAD_FRAC`, `CAR_LEFT_PAD_FRAC` in CarMapView vs the phone's chase camera.
4. **Congestion colors** — same green→yellow→orange→red gradient: phone computes from `congestion_numeric` (`levelFromNumeric` in `src/mapboxDirections.ts`), CarPlay mirrors via `carStore` route → `buildCongestionGradient`.
5. **Speedo + speed-limit sign** — same over-limit threshold (limit + 2 km/h), same red flash/pulse timing, same pop-out behavior, both driven off the same `carStore.speedLimitKmh` / GPS speed.

## Procedure
1. Diff the change: which of the 5 dimensions does it touch?
2. For each touched dimension, read BOTH sides and confirm the values/logic match (constants, colors, thresholds — exact, not approximate).
3. Report a 5-row ✅/⚠️ table. Fix any ⚠️ in the same change set.
4. Remind Jeff to eyeball BOTH surfaces in a light (day) AND dark (night) map mode — several past regressions only showed on one.

## Traps
- The CarPlay foreground GPS feed in `navNotification.ts` (~line 305) is the SOLE main-context writer for the car map — never remove it as "redundant" (re-breaks the CarPlay-shows-logo bug).
- CarPlay is a presentation surface only — no nav engine of its own; fix data upstream in `map.tsx`/`carStore`, not by forking logic into the CarPlay files.
