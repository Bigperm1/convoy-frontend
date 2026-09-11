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

# Hairpin Widgets + Watch — BUILD 75 roadmap (Jeff's call, 2026-08-16)

**Status: SPECCED 2026-08-16, slotted for 75 then; NOT built for 75. Jeff 2026-09-10 21:5x ("include it and also
add the new ios 27 phone full screen widget as well") put the whole family + the iOS 27 extra-large portrait widget
in scope for 77 — but ⛔ NONE OF IT WAS BUILT. Build 77/78 (cut 09-11) carries the Apple Watch companion and nothing
else widget-side; commit `14dcd19` touched only this file and the HANDOFF, zero Swift. `targets/widget/index.swift`
still declares `.supportedFamilies([.systemSmall, .systemMedium])` and has not been edited since the build-75 cut.
→ **THE FAMILY MOVES TO BUILD 79.** Split it, because the two halves have different blockers:
• the large + lock-screen families compile on TODAY's EAS image (Xcode 26) — buildable in 79 whenever Jeff says go;
• ⛔ the iOS 27 `systemExtraLargePortrait` widget CANNOT be built on EAS at all right now — see the blocker box below.
NATIVE work — none of this is OTA-able; BOTH platforms cut at the same number per the parity rule.**

> ### ⛔ BLOCKER — `systemExtraLargePortrait` needs an Xcode 27 EAS image that does not exist (VERIFIED 2026-09-11)
> The symbol is an SDK enum case, so it needs the **iOS 27 SDK = Xcode 27** at COMPILE time; no `@available` check
> helps, because the case is absent from the Xcode 26 SDK entirely. EAS's iOS image table
> (https://docs.expo.dev/build-reference/infrastructure/) tops out at **`macos-tahoe-26.5-xcode-26.6`** (= `latest`),
> and our `image: "auto"` on SDK 54 resolves to **`macos-sequoia-15.6-xcode-26.0`** — Xcode 26.0. A literal grep of the
> doc source for Xcode 27: zero hits, no beta image, no announced timeline. (GitHub Actions and Azure DevOps both
> already ship Xcode 27 preview runners; Expo shipped an Xcode 26 beta image ~3 weeks before Apple's GA last cycle,
> and has NOT repeated that this cycle.) iOS 27 GA = 2026-09-14.
> **✅ RESOLVED 2026-09-11 — the compile gate is BUILT and MEASURED (option c).** `targets/widget/index.swift` now
> declares the family behind `#if compiler(>=6.4) && canImport(WidgetKit, _version: 749)`, so the target compiles on
> today's Xcode 26 image with the family simply absent, and offers it the moment a build runs on an iOS 27 SDK.
> Measured matrix (`swiftc -target arm64-apple-ios17.0 -emit-sil`, local Xcode 26.6 = Swift 6.3.3 / iOS 26.5 SDK and
> Xcode 27.0b = Swift 6.4 / iOS 27.0 SDK; the third column is the dangerous mismatched toolchain):
>
> | gate | 6.3.3 + iOS26 | 6.4 + iOS27 | 6.4 + iOS26 |
> |---|---|---|---|
> | `compiler(>=6.4)` alone | closed | OPEN | **COMPILE ERROR** |
> | `canImport(WidgetKit, _version: 749)` | closed | OPEN | closed |
> | **BOTH — what ships** | **closed** | **OPEN** | **closed** |
>
> Negative controls, both measured: the ungated reference FAILS on Xcode 26 (`'systemExtraLargePortrait' is
> unavailable in iOS`), and a runtime `if #available(iOS 27.0, *)` ALONE also fails there — availability checking is
> not sufficient, because the iOS 26 SDK declares the case `@available(iOS, unavailable)` rather than omitting it.
> The real `HairpinWidget` target **BUILD SUCCEEDED** under Xcode 26.6 (the EAS-equivalent toolchain) with 0 SIL
> references to the symbol, and emits 2 under Xcode 27. Guarded by `scripts/trap-check.py` rule
> `bare-compiler-gate-in-target-swift` (proven to bite, exit 1, on a bare `compiler()` gate).
> ⚠ Module version, NOT OS version: WidgetKit is `664.5.28.100` in the iOS 26.5 SDK and `749.0.2` in iOS 27.0. An
> earlier pass tested `_version: 27`, saw both branches taken, and wrongly discarded the mechanism.
>
> **What is still needed to actually ship it:** (1) an EAS image with Xcode 27 — none exists yet, and note
> `image: "auto"` selects by Expo SDK version rather than by newest, so turning this on is a deliberate one-line
> pin in `eas.json`, not something that happens by itself; (2) **the full-page CONTENT design, which is Jeff's call**
> ([[preview-ux-before-shipping]]) — the gate currently scales the existing "Next up" layout, and the crew-snapshot
> design sketched below has never been previewed. (`eas build --local` remains a bad path: local builds get no EAS
> secret env vars, which kills the weather key on that binary.)

**What ALREADY ships (build 66 → 75, VERIFIED 09-10 in the repo):** ONE home-screen widget, `targets/widget`
"HairpinWidget" — "Next up": the next attending event / cruise with a live countdown, tap opens the Hub, small +
medium only (`.supportedFamilies([.systemSmall, .systemMedium])`), fed by `src/widgetFeed.ts` → the App Group
`group.com.sw0rdfisch.convoy` key `nextEvent` (written by the Hub on every events load and on app open). The
watch-face complication (crew-live count, `targets/watch-widget`) is built with the watch companion (77, unshipped).
Nothing below this line exists yet except the three deep links (routed in JS since build 75).

## iOS 27 full-page widget — `WidgetFamily.systemExtraLargePortrait` (VERIFIED 09-10 from Apple's docs)
- Apple: "An extra-large widget that uses a portrait orientation. … can appear on the Home Screen on iOS, on the
  Today View on iOS and iPadOS, on the Desktop on macOS, and on visionOS. This extra-large widget appears in a portrait
  orientation, similar to the widget of a visionOS app." Introduced iOS 27.0 / iPadOS 27.0 / macOS 27.0 (visionOS 26.0).
  It is the page-height portrait size on the iPhone Home Screen — the "full screen widget".
- **MEASURED SIZES (2026-09-11, on the iOS 27.0 simulator runtime — Apple has published NONE).** The family is a
  **4-column x 6-row** footprint: same width as medium/large, exactly 2 grid rows taller than large. Aspect ratio
  ~1 : 1.618. On a 402x874 iPhone 17 Pro it occupies y=90 to y=655.7, i.e. ~87% of screen width and ~65% of height —
  "full page" is close but not literal; the status bar, the widget label, the Search pill and the dock stay visible.

  | screen (pt) | iPhone | XL portrait | large | medium |
  |---|---|---|---|---|
  | 390x844 | 17e / 16e / 14 / 13 | **342 x 554** | 342 x 358 | 342 x 162 |
  | 402x874 | 17, 17 Pro | **349 x 565** | 349 x 365 | 349 x 164 |
  | 420x912 | Air | **366 x 591** | 366 x 382 | 366 x 172 |
  | 440x956 | 17 Pro Max | **378 x 611** | 378 x 394 | 378 x 176 |

  ⚠ Apple's HIG iPhone dimensions table is STALE (last dimension revision 2022-11-03): every iPhone widget grew
  ~+3.7 pt per axis in iOS 26 (Liquid Glass), and the table has no rows for the 402/420/440 pt screens at all.
  Corner radius measured ~35-39 pt on iOS 26/27 (was ~29 on iOS 18) — use `ContainerRelativeShape`, never a constant.
  `#Preview(as: .systemExtraLargePortrait)` and `WidgetPreviewContext(family:)` both compile, but need the iOS 27 SDK
  and an iOS 27 preview destination.
- **MOCKUPS RENDERED 2026-09-11 — awaiting Jeff's pick.** Three concepts, real SwiftUI rendered at 349x565 pt @3x over a
  real Mapbox dark static map of Abbotsford, plus an in-context iPhone 17 Pro home screen at measured geometry
  (renderer + PNGs in the session scratchpad, `mock/Render.swift` + `mock/Compose.swift` — throwaway, not in the repo):
  **A · CREW PAGE** map + crew ring row + next-cruise card + Comms — the spec below, most information per glance.
  **B · DRIVE READY** a "LEAVE BY 8:42" Departure-IQ hero over a route map, crew strip, Start-drive button — action-first.
  **C · DASHBOARD** three stat tiles (km this week / next cruise / crew out), map, crew list with distances.
  ⚠ **DATA GAP — none of the three can be built from what the app writes today.** The App Group carries exactly one key,
  `nextEvent` = `{title, startAt, kind, venueLabel}` (`src/widgetFeed.ts`). Crew avatars/status/distances, the snapshot
  map image, the km total and the Departure-IQ "leave by" all need NEW payload written into the App Group, and the map
  needs a rendered snapshot image (a widget cannot draw a live Mapbox view and must not network). The Comms/Start-drive
  buttons need an AppIntent + `openAppWhenRun` — `targets/` has none yet. Scope that plumbing with the design choice.
- Content (mockup first, Jeff's OK, then Swift — [[preview-ux-before-shipping]]): the crew snapshot map at full height
  (static image, same privacy rules as the medium), the crew avatar row with live / driving / parked, the next cruise
  or the Departure IQ "leave by" window, and the Comms launcher button (App Intent, `openAppWhenRun`) across the bottom.
- Build constraints, all VERIFIED 09-10: the case only compiles against the iOS 27 SDK → Xcode 27 (this Mac has Xcode 27.0
  beta 27A5252f with the iOS 27.0 SDK beside Xcode 26.6; Xcode 27 GM expected with iOS 27 in September 2026). EAS Build's
  image list has NO Xcode 27 image yet (`latest` = `macos-tahoe-26.5-xcode-26.6`; our `eas.json` says `"image": "auto"`
  = the SDK 54 default, Xcode 26.0) — the 77 cut needs an Xcode 27 image or a local archive. The target's
  `deploymentTarget` stays 17.0: add the family under `if #available(iOS 27, *)` so iOS 17–26 phones keep the small /
  medium / large / lock-screen widgets and iOS 27 phones also get the portrait page. `@bacons/apple-targets` 4.0.7 is
  the plugin already wired in `app.json`.
- Check before the cut: Expo SDK 54 on Xcode 27 beta (an expo issue reported SDK 56 source builds failing on Xcode 27
  beta in June; SDK 54 is untested here) — one local `expo prebuild --clean` + archive with `DEVELOPER_DIR` = Xcode-beta.

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
1. **Build 75**: extension target + App Group + small/medium/large + lock screen
   accessories + mic-launcher intent + deep links + snapshot endpoint.
2. **75.x OTA-tunable bits**: everything INSIDE the app (deep-link behavior, snapshot
   camera math, refresh triggers) stays JS and OTA-able; the SwiftUI views do not.
3. **Phase 2**: Live Activity (ActivityKit + push updates; needs backend push work).
4. **Phase 3**: Android Glance pair.

## Apple Watch (added same day — Jeff: "turnbyturn wrist taps")

**BUILDING for 77** — spec docs/superpowers/specs/2026-09-10-apple-watch-companion-design.md, plan docs/superpowers/plans/2026-09-10-apple-watch-companion.md; haptics = WKHapticType.navigationLeftTurn/RightTurn (verified in WatchKit 26.5), not .directionUp/.directionDown.

**Tier 0 — free-ish, OTA:** iPhone local notifications MIRROR to a paired Watch when
the phone is locked. Post a turn-approach local notification (glyph + street + dist)
while navigating with the phone locked → wrist tap at every turn, zero native work.
Limits: only when the phone is locked (pocket / dark mount — i.e. the CarPlay case),
standard tap not directional, and it must respect the existing notification-permission
gate. Suppress when the phone screen is on (the banner would double the in-app one).

**Tier 1 — watchOS companion app (native target, build 75 with the widgets):**
- Turn card: maneuver glyph + street + live countdown, over WatchConnectivity from
  the SAME tbt state that feeds the car list. No new nav logic.
- DIRECTIONAL wrist taps: WKInterfaceDevice .directionUp/.directionDown (Apple's own
  turn-guidance haptic vocabulary) — distinct left vs right patterns at N metres.
- Complication: crew-live count on the watch face.
- Later: wrist PTT (watch mic → WCSession relay → livePtt) — real walkie from the
  handlebars; and crew glance.
- ⚠ SPIKE REQUIRED at build time: background-haptic keep-alive strategy — workout
  session (komoot pattern, review risk for "driving") vs watch-local notifications
  scheduled from the phone (cleaner, standard haptic only). Decide with a device in
  hand; do not commit to either in code before the spike.
