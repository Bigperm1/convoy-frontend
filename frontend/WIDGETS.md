# Hairpin Widgets — spec for the next native build (74+)

**Status: SPECCED 2026-08-16 (Jeff: "YES, can we have it all with different size
widgets too?"). NATIVE work — none of this is OTA-able. Ships as its own target in
the next paid build, runtime bump, BOTH platforms cut per the parity rule (the
widget is iOS-first but Android must be rebuilt at the same runtime or it orphans).**

## The family, by size

### Home screen (WidgetKit)
| Size | Content |
|---|---|
| **Small** | EITHER the **Comms launcher** (big candy mic button, crew-live count) OR the **crew count + status dots** — user picks which small widget to add; both ship. |
| **Medium** | **Crew snapshot**: static map image with crew car-dots + count + freshness stamp ("as of 4:12 PM"). Tap → opens the crew overview. |
| **Large** | Crew snapshot (taller map) + a row of avatars with live/driving/parked state + next planned cruise from the Hub, or Departure IQ's "leave by" window when one is armed. |

### Lock screen (iOS 16+ accessories)
| Slot | Content |
|---|---|
| **Circular** | Crew-live count (e.g. "3🟢") or mic glyph launcher. |
| **Rectangular** | "3 crew live · Olaf driving" one-liner; during a drive: next turn + distance. |
| **Inline** (above clock) | "Hairpin: 3 live" or drive ETA. |

### StandBy (iOS 17, phone charging sideways in the mount)
The medium crew-snapshot widget renders in StandBy automatically — worth checking the
dark-map contrast there, free win otherwise.

### Live Activity + Dynamic Island (phase 2, the drive experience)
During turn-by-turn: next maneuver + distance + ETA + crew count, lock screen +
Island, updated push-driven via ActivityKit tokens (near-real-time, unlike widget
timelines). Pairs with car-list mode: phone is already the secondary screen during
CarPlay/AA drives. This is the Apple-Maps-grade surface and likely the biggest
perceived win of the whole family.

### Android (phase 3)
Glance app widgets: crew snapshot (resizable) + mic launcher. Same data plumbing.

## Hard platform constraints (so nobody re-derives them)
- Widgets are **timeline snapshots**, not live views: refresh budget ≈ every 15 min
  (more generous right after app use). The crew map is honest as a stamped snapshot,
  never sold as live. `WidgetCenter.reloadTimelines` fires on app foreground/
  background and on presence events while the app runs; a silent push can nudge a
  refresh within iOS's budget.
- **No microphone in a widget process — ever.** The mic button is an App Intent with
  `openAppWhenRun`: launches the app straight into Comms transmit-armed
  (deep link `hairpin://comms/transmit`). One tap → talking in ~a second. Same deep
  link serves the Action Button via Shortcuts. iOS 17 interactive widgets can run
  audio PLAYBACK intents without opening the app, not capture.
- **No GL map in a widget.** The snapshot is a **Mapbox Static Images API** render —
  the exact machinery RerouteCard's preview already uses. Camera = the same fit the
  in-app Crew button computes (fitBounds around crew, capped zoom).

## Plumbing
- **Target**: WidgetKit extension via `@bacons/apple-targets` (Expo config-plugin
  era-compatible; prebuild-safe with our gitignored `ios/`). Verify plugin choice at
  build time — ecosystem moves.
- **Data**: App Group (`group.com.sw0rdfisch.convoy`) shared container. The app
  writes `widget-state.json` (crew list, counts, cruise, departure window) + the
  latest snapshot PNG whenever presence updates while running; a tiny backend
  endpoint (`GET /widget/snapshot`) lets the widget's own timeline provider refresh
  the image when the app hasn't run — it returns the static-map URL + crew payload
  for the account.
- **Privacy — non-negotiable**: the snapshot renders ONLY what presence already
  broadcasts (post-`shareablePosition` positions: parked pin = car spot, ghost =
  absent). The widget endpoint reads the same feed peers see — it can never become a
  side-channel around [[location-privacy-single-gate]]. Ghost users: the widget
  shows crew WITHOUT self.
- **Token security**: static-image URLs are minted with a URL-restricted public
  token (Mapbox token rules) or proxied by the backend — never the app's full-scope
  token in a widget-visible URL.
- **Deep links**: `hairpin://comms/transmit`, `hairpin://crew`, `hairpin://drive?to=home|work`
  — routed in expo-router; the transmit link arms PTT after the mic-permission gate
  (never prompts from a cold widget launch; undetermined mic permission → Comms
  screen with the normal staggered prompt, per permissionGate rules).

## Phasing
1. **Build 74**: extension target + App Group + small/medium/large + lock screen
   accessories + mic-launcher intent + deep links + snapshot endpoint.
2. **74.x OTA-tunable bits**: everything INSIDE the app (deep-link behavior, snapshot
   camera math, refresh triggers) stays JS and OTA-able; the SwiftUI views do not.
3. **Phase 2**: Live Activity (ActivityKit + push updates; needs backend push work).
4. **Phase 3**: Android Glance pair.
