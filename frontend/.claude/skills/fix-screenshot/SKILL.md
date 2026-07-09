---
name: fix-screenshot
description: Fix a UI defect from an uploaded iPhone or CarPlay screenshot — locate the surface in code, apply the styling fix, gate it, and offer the OTA. Use whenever Jeff drops a screenshot with a visual complaint ("too dark", "not white", "misaligned", "doesn't match").
---

# Fix UI from a screenshot

Jeff's primary feedback loop: screenshot + plain-English gripe → surgical fix → OTA → he re-tests on device. Optimize for getting the RIGHT file on the first try.

## 1. Read the screenshot(s) carefully
- Identify the surface (which screen/panel/chip) and the exact complaint (color, tint, alignment, size, missing element).
- Phone screenshots are pixel-accurate; CarPlay photos are photos of a head unit — expect glare/exposure, judge relative differences not absolute colors.
- If two images are provided, the second is usually the REFERENCE ("make it look like this").

## 2. Locate the code — surface map
| What's in the shot | Where it lives |
|---|---|
| Map HUD (weather chip, speedo, zoom, compass) | `app/(app)/map.tsx` styles |
| Drive preview drawer (route chips, Arrive/min, Start) | `app/(app)/map.tsx` (~line 3000 render, ~3800 styles) |
| Turn-by-turn banner / lane row | `src/components/TurnByTurnNav.tsx` |
| Bottom ETA bar / step list during nav | `src/components/StepDrawer.tsx` |
| CarPlay banner/ETA/speedo/chips | `src/carplay/ConvoyCarPlay.tsx` |
| CarPlay map/camera/car | `src/carplay/CarMapView.tsx` |
| Glass/tint anywhere | `src/Glass.tsx` (`hudTint`, `drawerTint`, GlassFill radius rules) |
| Settings pages | `app/(app)/settings/*` + `src/components/settingsKit.tsx` |
| Music screen | `app/(app)/music.tsx` |
| Search / "Where to?" | `src/NavSearchScreen.tsx`, `src/components/MemberCarousel.tsx` |
| Toasts | `src/components/AlertToast.tsx` |
| Colors/theme | `src/theme.ts` (`COLORS`), brand green `#2DEC86`, system green `#30D158` |

## 3. Fix rules
- Match the existing style idiom; change the minimum that fixes the complaint.
- Text-on-glass readability: near-white `#F4F4F4`/`#E5E5EA`, never `#808080` grey (repeated complaint).
- If the change touches the phone HUD → run the `/carplay-parity` checklist before shipping.
- Known glass traps: "diamond" creases / cut circles = GlassFill radius bug (pass the radius INTO GlassFill); glass over light maps needs a dark wash; no real GlassView inside animated modals.
- White/colorless elements die under opacity fades — dim with borders/dots instead of whole-element opacity.

## 4. Verify + ship
- `yarn typecheck` clean; no new lint errors in touched files.
- These are native screens — browser preview can't exercise them; say so honestly and rely on Jeff's on-device check.
- Offer the OTA (`/ship-ota`); after shipping, tell him exactly WHAT to look at to confirm the fix.
- If the fix involved judgment (spacing, exact shade), say so and invite the follow-up screenshot — iterate, don't claim perfection.
