#!/usr/bin/env python3
"""trap-check.py — a release gate for the traps we have already paid for.

Every rule here is a textual signature of a bug that shipped, was root-caused, and
would come straight back if someone re-typed the old pattern. Run it in the OTA
ritual next to `yarn typecheck` and `doc-check.py --live`; exit 1 blocks the publish.

    python3 scripts/trap-check.py            # check
    python3 scripts/trap-check.py --list     # print the rules

Add a rule the day a root cause is closed, not later. Cite the date and the receipt.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (id, glob, regex, why) — regex is searched per FILE (multiline).
RULES = [
    (
        "imminent-turn-callout-not-priority",
        ["src/nav.ts"],
        r"speak\(roundabout[^;\n]*`\$\{verb\}\.`\s*\)",
        "2026-09-11 (Jeff: 'SCOUT CUT OFF THE TURN LEFT ONTO HIGHWAY TOWARDS VANCOUVER'): the IMMINENT turn callout "
        "— the 'Turn left.' you hear as you reach the intersection — must pass { priority: true } so the 1.5 s rate "
        "gate cannot drop it. His receipts: 21:16:55.416 route-swap, 21:16:56.341 tts-play len=43 (the new route's "
        "prepare cue, 6.7 s long), 21:16:57.385 tts-skip why=rate len=11 (the turn callout DROPPED 1.044 s into the "
        "gate), 21:17:04.336 watch-tap kind=now d=33 — he was AT the turn. The reroute's own prepare cue ate its own "
        "first turn. tools/sim-qc/arrival_speech_test.mts section F gates the RULE (speakRateSkips); this rule gates "
        "the CALL SITE, because a Codex review proved F2 stays green when the priority option is removed here "
        "(the gate tests the helper, never nav.ts). The pattern is anchored to speak( AND the bare-verb IMMINENT form `${verb}.`) — the "
        "PREPARE cue two lines below is `In <dist>, <verb> onto <street>.` and is correctly droppable, so a "
        "broader pattern flags it too (it did, attempt 1), and the prefetchTts() pre-synthesis of the same string "
        "two lines below is not a speak at all (attempt 2). Same family as the arrival line losing to "
        "a prepare cue 2026-09-03.",
    ),
    (
        "chase-pitch-reads-speed",
        ["src/chasePitch.ts", "src/ConvoyMapbox.tsx", "src/carplay/CarMapView.tsx"],
        r"(?m)^\s*export function chasePitch\([^)]*\)[^{]*\{(?![\s\S]{0,300}?return CHASE_PITCH_FIXED;)",
        "2026-09-11 (Jeff: 'seems like everybody is at a fixed pitch ... i agree with the pitch change. go'): the "
        "follow camera's TILT must not move with speed. It used to ramp CHASE_PITCH_CITY 48 -> CHASE_PITCH_HIGHWAY 60 "
        "between 45 and 95 km/h, and MEASURED on his 09-11 drive home (ogb3m4-967731, 88 cam-probe rows, 31.4 min) "
        "that cost 168 DEGREES of tilt travel with 20 direction reversals, the horizon rising and falling with every "
        "gap in traffic: 17:33-17:36 alone ran 54.5 -> 48.3 -> 48 -> 48.4 -> 52.5 -> 48.3 -> 48 -> 48.1 -> 52.2 -> "
        "54.7. CAM_PITCH_SLEW_PER_S and the tau-1400 low-pass were ALREADY in place and did not stop it — they smooth "
        "the path while the TARGET churns, so filtering harder only adds lag to the churn. Prior art, fetched and "
        "citation-checked the same day: Mapbox Navigation SDK defaultPitch = 45.0, Google Navigation SDK 45, MapLibre "
        "Navigation iOS 45 — not one drives pitch from speed, and the two that vary it LOWER it as a maneuver nears. "
        "chasePitch must return CHASE_PITCH_FIXED and nothing else; change the CONSTANT if the angle is wrong. The "
        "gate tools/sim-qc/chase_pitch_test.mts asserts invariance at runtime; this rule guards the source text.",
    ),
    (
        "carplay-warm-root-failure-without-failover",
        ["src/carplay/ConvoyCarPlay.tsx"],
        r"console\.warn\('\[CarPlay\] setRoot failed'(?![\s\S]{0,400}failoverToColdRoot)",
        "2026-09-11 (Jeff: 'CARPLAY END AND SEARCH BUTTONS DID NOT WORK', and 'do not guess be precise'): the warm "
        "root's setRoot() must NEVER fail silently. The phone map screen claims carPlayHookOwnsRoot on mount, so the "
        "COLD bootstrap has already logged `carplay-idleroot-skip hookOwns=1` and will not retry this connect. If the "
        "warm setRoot then throws, the head unit is left with NO root template of ours: every nav-bar button is dead, "
        "and because no JS handler was ever attached, pressing one logs NOTHING — a dead session is byte-identical to "
        "an untouched one. That is exactly the shape of Jeff's two 09-11 connects (09:07 and 14:02): carplay-onconnect "
        "+ car-chrome + carplay-live-paint + idleroot-skip, and zero carplay-tap rows, while `carplay-tap:car-end` and "
        "`carplay-tap:car-search` landed the same day for three other testers on the same runtime 1.28.0. The catch "
        "here was a bare console.warn for two months. It must hand the screen back to the cold root "
        "(failoverToColdRoot -> setCarPlayHookOwnsRoot(false) + requestCarPlayIdleRoot) — the path the fleet's "
        "`src=cold` taps prove still works — and log carplay-root / carplay-root-failover so the next connect names "
        "the cause instead of leaving absence to be argued about.",
    ),
    (
        "bare-compiler-gate-in-target-swift",
        ["targets/**/*.swift"],
        r"(?m)^\s*#if\s+compiler\(>=[0-9.]+\)\s*(?:(?://|/\*).*)?$",
        "2026-09-11: a `#if compiler(>=X)` gate alone is NOT an SDK check. It was used to hide "
        "WidgetFamily.systemExtraLargePortrait (iOS 27 only) from the Xcode 26 SDK, where that case is "
        "@available(iOS, unavailable) and merely naming it fails to compile. Apple ships Swift MINOR bumps "
        "inside Xcode POINT releases (13.3->5.6, 14.3->5.8, 15.3->5.10, 16.3->6.1, 26.4->6.3) with the SDK "
        "major unchanged, so a 'new Swift + old SDK' toolchain opens a bare compiler gate and BREAKS THE "
        "BUILD — measured: swiftc 6.4 against the iOS 26.5 SDK errors, while compiler(>=6.4) && "
        "canImport(WidgetKit, _version: 749) stays correctly closed. Pair every compiler() gate with a "
        "canImport(<Module>, _version: <MODULE version, not the OS version>) on the same line. "
        "See the comment block in targets/widget/index.swift for the full measured matrix.",
    ),
    (
        "constant-self-lift-in-style",
        ["src/**/*.tsx"],
        r"modelTranslation:\s*\[\s*0\s*,\s*0\s*,\s*(?:SELF_MODEL_LIFT_M|SELF_ARROW_LIFT_M|PEER_MODEL_LIFT_M|\d)",
        "2026-09-10: the self car was drawn 10 m in the air EVERYWHERE (16 for the arrow) to beat the 3D buildings' "
        "depth test — 3 pt up the road on the highway, 56 pt on Jeff's exit ramp. The lift is 0 on a road and rises only "
        "off it (src/selfLiftRule.ts); it rides the SOURCE feature (`trn`) like the size and the heading.",
    ),
    (
        "model-scale-zoom-curve",
        ["src/**/*.tsx", "src/**/*.ts"],
        r"modelScale:\s*(?:scale\s*\?\?\s*)?(?:CAR_MODEL_SCALE_SIZED|ARROW_MODEL_SCALE|CARPLAY_ARROW_SCALE|carModelScale\(|scaleCurveForPoints\(|\[\s*['\"]interpolate['\"][^\]]*\[\s*['\"]zoom['\"]\s*\])",
        "2026-09-03: Mapbox evaluates a ['zoom'] curve in model-scale at the TILE's integer zoom, so the 3D car "
        "swells up to 2x between whole zooms and pops at each crossing (Jeff's CarPlay video, frame-measured). "
        "The self car's size rides the SOURCE feature per tick: modelScale: ['get','scl'] via modelScaleForPoints().",
    ),
    (
        "per-tick-line-trim-in-style",
        ["src/**/*.tsx"],
        r"lineTrimOffset\s*:\s*\[?\s*(?:Math\.\w+\(\s*[^)]*(?:progress|frac|trim|cut)|trim|cut|frac|ribbon|_frac|progress)",
        "2026-09-01: any per-tick CONTENT change to a layer `style` is a main-thread read-modify-write of the "
        "whole layer (0x8BADF00D watchdog kills). The ribbon is CUT in the source (src/routeRibbon.ts), never trimmed in paint.",
    ),
    (
        "per-tick-rotation-in-style",
        ["src/**/*.tsx"],
        r"(?:iconRotate|modelRotation)\s*:\s*(?:\[\s*[^\]'\"]*\b(?:heading|hdg|r\.heading)\b|r\.heading|heading\b)",
        "2026-09-01: the marker heading rides the source feature (['get','rot'] / ['get','hdg']); writing it into "
        "the layer style per frame is the same watchdog-kill mechanism as the ribbon trim.",
    ),
    (
        "arrow-model-id-equality",
        ["src/**/*.tsx", "src/**/*.ts"],
        r"modelId\s*===\s*ARROW_MODEL_ID",
        "2026-09-09: a PAINTED arrow's model id is ARROW_MODEL_ID + '_' + <paint>, so `===` is FALSE for it. That "
        "drew every painted arrow at the CAR's 10 m lift instead of the arrow's 16 m — under the route ribbon, "
        "which is the exact thing the 16 m exists to prevent — and once the route trim started feeding the lift "
        "back in to place the cut (it asks selfIsArrow, true for a painted arrow) the line began starting far too "
        "far ahead for those drivers. Use modelId.startsWith(ARROW_MODEL_ID) so one predicate answers both.",
    ),
    (
        "tts-fetch-without-timeout",
        ["src/**/*.ts", "src/**/*.tsx"],
        r"api\.post\(\s*[\"']/tts[\"'](?:(?!timeout)[^;])*?\)\s*[;.]",
        "2026-09-09 (Jeff: \"the annoucments were a little late\"): the /tts fetch sits on the critical path of a "
        "turn callout and the api client's own timeout is 60 s — a page-load budget, not a callout budget. MEASURED "
        "on his 2026-09-08 drive to work: one clip took 32.5 s (tts-done ms=32489 len=36) and the announcement "
        "queued behind it played EIGHTEEN SECONDS late. Always pass an explicit { timeout: TTS_FETCH_TIMEOUT_MS }; "
        "on timeout stay silent (the banner still shows the turn) rather than let one slow clip hold the queue.",
    ),
    (
        "duplicate-arrival-headsup",
        ["src/**/*.ts", "src/**/*.tsx"],
        r"speak\([^)]*you will arrive at your destination",
        "2026-09-09 (Jeff): \"you have an 'arrived at destination' before the weather/destination/end greeting when "
        "arriving at the destination. please remove that.\" The composed arrival line already opens with \"You have "
        "arrived at <place>.\", so a spoken final-leg heads-up is the same news twice ~20 s apart — VERIFIED on his "
        "2026-09-08 09:28 drive: tts-say len=45 -> tts-play len=50 (this sentence) finished and the arrival line "
        "len=82 played straight behind it. It is also the only spoken line containing \"your\", which is the "
        "fragment he heard truncated. Reaching prepareM must still call prefetchArrivalLine() — that is what keeps "
        "the arrival line playing from cache (the 2026-09-03 'Scout drops sentences on arrival' fix) — but it must "
        "not speak.",
    ),
    (
        "self-model-lift-hardcoded",
        ["src/**/*.tsx", "src/**/*.ts"],
        r"modelTranslation:\s*\[[^\]]*?,\s*\d+(?:\.\d+)?\s*\]",
        "2026-09-09: the self marker is drawn N METRES IN THE AIR to beat the 3D buildings' depth test, and on a "
        "pitched camera that moves it FORWARD up the road by a screen distance that DOUBLES with every zoom level "
        "(3 pt at highway zoom, 62 pt on an exit ramp — MEASURED: two simulator frames at an identical pinned "
        "camera, lift on vs off, the car moved 17.2 pt). The route trim must add the SAME lift back to the cut or "
        "the drawn car sits past the line start and the ribbon runs under it (Jeff, 2026-09-07 exit 90; it had "
        "already been 'fixed' twice by changing the lead, which was never wrong). So the altitude may NOT be a "
        "literal here: use SELF_MODEL_LIFT_M / SELF_ARROW_LIFT_M from src/routeTrim.ts, which is the single source "
        "the trim reads. Gate tools/sim-qc/self_lift_lead_test.mts.",
    ),
    (
        "callout-text-translate-in-points",
        ["src/**/*.tsx"],
        r"text(?:Translate|TranslateAnchor)\s*:",
        "2026-09-08: Mapbox multiplies a symbol's text-size and icon-size by a PERSPECTIVE RATIO on a pitched "
        "camera, so a billboarded callout SHRINKS with distance. `text-translate` is a paint property in constant "
        "screen POINTS and is not scaled by it, so the destination-weather temperature climbed out of the top of "
        "its box on Jeff's head unit (2026-09-07). MEASURED: across +350 m the text drifted 16.5 -> 10.0 pt below "
        "the box top with translate, and held 16.5 -> 13.7 pt with an ems textOffset. Offset symbol text in EMS "
        "(src/calloutTextOffset.ts); gate tools/sim-qc/callout_offset_test.mts.",
    ),
    (
        "native-build-version-constant",
        ["src/**/*.ts", "src/**/*.tsx", "app/**/*.tsx"],
        r"Constants\.nativeBuildVersion",
        "2026-09-03: removed in expo-constants 18 — every reader silently fell back to the iOS buildNumber. "
        "Use releaseBuildNumber()/nativeBuildNumber() from src/buildNumber.ts.",
    ),
    (
        "bare-eas-update-in-skill",
        [".claude/skills/**/*.md", "scripts/*.sh"],
        r"(?m)^\s*(?:npx\s+)?eas(?:-cli)?\s+update\s+--branch",
        "2026-08-30: a bare `eas update` inlines an EMPTY EXPO_PUBLIC_OPENWEATHER_KEY and kills weather on every "
        "surface. Publish only through `npx eas-cli env:exec preview \"npx eas-cli update ...\"`.",
    ),
    (
        "cut-from-foreign-polyline-fraction",
        ["src/**/*.tsx"],
        r"ribbonCutM\s*=\s*\(routeProj\s*&&\s*ribbonPartition\)\s*\?\s*_?fracDrawn\s*\*\s*ribbonPartition\.totalM\s*\+",
        "2026-09-03: frac from a projection onto the nav polyline applied to the dense `coordinates` partition drifts "
        "by the two lengths' difference (tens of metres mid-route) and ran its own ease clock — the line reached the "
        "car's roof on CarPlay. The cut anchors to the DRAWN car via routeRibbon.alongMOnPartition().",
    ),
    (
        "off-route-tick-without-slot-sweep",
        ["src/nav.ts"],
        r"(?s)const nowT = Date\.now\(\);(?:(?!sweepRerouteInFlight\().)*?offRouteTick\(offRouteGateRef\.current",
        "2026-09-05: the ONE reroute slot (src/rerouteSlot.ts) is aged from LOCATION FIXES — sweepRerouteInFlight(nowT) "
        "must run BEFORE the off-route decision on the same tick, or a stuck request holds the gate `inflight` past the "
        "timeout and, with JS timers frozen, nothing else ever frees it (Rodrigo's stacked-request storm).",
    ),
    (
        "off-route-tick-without-inflight-age",
        ["src/nav.ts"],
        r"(?s)offRouteTick\(offRouteGateRef\.current,\s*\{(?:(?!rerouteInFlightMs).)*?\}\)",
        "2026-09-05: the gate can only hold `inflight` if the tick input carries rerouteInFlightMs — drop it and the "
        "one-in-flight bound silently disappears while every Node gate still passes (the gate tests the pure slot, "
        "not this wiring).",
    ),
    (
        "off-route-handler-without-claim-ticket",
        ["src/nav.ts"],
        r"(?<!try \{ )options\?\.onOffRoute\?\.\(\)",
        "2026-09-05 (Codex pass 3): the reroute slot is claimed through a one-shot ticket armed IMMEDIATELY before "
        "the off-route handler runs — `armRerouteClaim(); try { options?.onOffRoute?.(); } finally { dropRerouteClaim(); }`. "
        "A bare call means no reroute is ever registered and the gate can never hold `inflight`, while every Node gate still passes.",
    ),
    (
        "off-route-trip-without-armed-ticket",
        ["src/nav.ts"],
        r"(?s)if \(decision\.trip\) \{(?:(?!armRerouteClaim\(\)).)*?onOffRoute",
        "2026-09-05 (Codex pass 3): the trip block must arm the claim ticket before invoking the handler — see "
        "off-route-handler-without-claim-ticket.",
    ),
    (
        "route-fetch-awaits-before-slot-claim",
        ["src/nav.ts"],
        r"(?s)export async function (?:fetchRoutes|fetchRouteViaStops)\((?:(?!claimRerouteSlot\().)*?\bawait\b",
        "2026-09-05 (Codex pass 3): both route fetches must call claimRerouteSlot(t0, ctl, …) BEFORE their first await, or the "
        "one-shot ticket is dropped by the tick's `finally` before the fetch can take the slot (the claim is synchronous by design).",
    ),
    (
        "reroute-claim-wrapper-detached",
        ["src/nav.ts"],
        r"(?s)function claimRerouteSlot\([^)]*\)[^{]*\{(?:(?!slotClaim\().)*?\}",
        "2026-09-05 (Codex pass 3): nav.ts's claimRerouteSlot wrapper must forward to src/rerouteSlot.ts's slotClaim — deleting "
        "that one call disables the whole bound and neither the storm gate (which drives the pure module) nor the older rules see it.",
    ),
    (
        "aborted-route-result-returned",
        ["src/nav.ts"],
        r"(?s)route-fetch-settled-late ms=\$\{ms\} n=\$\{mbRoutes\.length\}(?:(?!ctl\.signal\.aborted\) return \[\]).)*?preferCurbArrival\(|route-fetch-settled-late ms=\$\{ms\} n=1 (?:(?!ctl\.signal\.aborted\) return null).)*?mapboxToNavRoute\(mb\)",
        "2026-09-05 (Codex pass 3): a route fetch whose controller was aborted must return nothing — if the platform ignores "
        "abort(), the late response is computed from a position the car left 15+ s ago and map.tsx would install it inside the "
        "30 s / 500 m staleness window whenever no newer request superseded it.",
    ),
    (
        "absence-receipt-uses-droppable-logevent",
        ["src/**/*.ts", "src/**/*.tsx"],
        r"logEvent\(\s*[`'\"](?:aa-stack|aa-crumb)",
        "2026-09-09: plain logEvent DROPS the row outright when the Supabase client is not constructed yet "
        "(`if (!supabase) return`) — the normal state during an Android Auto / CarPlay cold connect, which is "
        "exactly when these rows fire. The aa-stack instrument is read for ABSENCE (\"no op=root, so our JS never "
        "set the car root; blame the native side\"), so a silently dropped row is indistinguishable from code that "
        "never ran, and would send the next investigation at the wrong layer. Caught before publish, on the very "
        "receipt written to answer Say Phin's black screen. Use logEventReliable, which queues on a missing client "
        "and delivers `late` on a later launch. Contract: src/crashBreadcrumb.ts.",
    ),
    (
        "trip-recorded-from-route-distance",
        ["src/**/*.ts", "app/**/*.tsx"],
        r"recordTrip\(\{(?:(?!travelledM)[\s\S]){0,600}?\}\)",
        "2026-09-09: recordTrip credited the ROUTE'S PLANNED distance, not the distance driven, and "
        "nothing in the app could tell the difference. Four rows in Jeff's own history banked a full "
        "17.2 km route ~139 s after it was plotted with top_speed 0 — 445 km/h average, 68.9 km of his "
        "1,989.5 km lifetime total that he never drove, all of it on the club leaderboard. Every call "
        "site must pass `travelledM` from src/tripOdometer.ts (the headless cold-arrival path in "
        "navNotification.ts is the ONE documented exception and passes travelledM: undefined "
        "explicitly). Gate: tools/sim-qc/trip_odometer_test.mts.",
    ),
    (
        "draw-heading-from-switch-stack",
        ["src/**/*.tsx"],
        r"const (?:drawHdg|selfHeadingLocked)\s*=\s*(?:carSnapped|selfSnapped)\b",
        "2026-09-09 (Jeff: 'why is it drifting and at low speeds ... why cant this be fixed'): the drawn car "
        "used to be a stack of threshold SWITCHES on a 1 Hz GPS course — snap/unsnap, cornerBlend, cornerNose, "
        "the polyline tangent as the nose. The same King Rd corner produced the same bad row on three drives "
        "across five revisions (15.9 / 10.8 / 14.8 m; nose = the 124° bisector). During guidance the drawn "
        "pose is src/poseEstimator.ts (`est`), gated by tools/sim-qc/pose_estimator_test.mts; the old formula "
        "is computed only as `oldDrawHdg` / `oldSelfHeading` for the receipts. Do not assign the DRAWN "
        "heading from the switch stack again.",
    ),
    (
        "drive-feed-not-navigation-grade",
        ["src/navNotification.ts"],
        r"(watchPositionAsync|startLocationUpdatesAsync)\([^)]*accuracy:\s*Location\.Accuracy\.(High|Highest|Balanced)\b",
        "2026-09-10 (Jeff: 'how do the big 3 do the GPS?'): the head unit's two feeds asked expo for "
        "Accuracy.High, which expo maps to kCLLocationAccuracyNearestTenMeters — ten-metre class, no "
        "sensor fusion — and a JS gyro was bolted on top to compensate. Apple, Google and Mapbox fuse in "
        "the OS/native layer: every drive-time request goes through driveLocationOptions() "
        "(BestForNavigation, or High only when the user chose Lite GPS). Never a literal here.",
    ),
    (
        "raw-segment-bearing-as-the-nose",
        ["src/ConvoyMapbox.tsx", "src/carplay/CarMapView.tsx"],
        r"(roadHdg(Ahead)?\s*[:=][^,;\n]*?\b\w+\??\.(bearing|bearingSmooth)\b|roadHdg(Ahead)?\s*[:=][^,;\n]*?noseBearing\()",
        "2026-09-10 (the road heading): the estimator's nose follows the line's direction averaged over "
        "the vendors' window (projectOntoRoute roadHdg / roadHdgAhead) — NEVER the raw segment `bearing` "
        "(at a single-vertex corner that is the two legs' bisector: King Rd hdg=124, 35° off the road, "
        "three drives) and never `bearingSmooth` (bisectors mixed across the WHOLE segment: 22° off "
        "mid-way down a straight that ends in a 90° turn — the staged-off lead-in).",
    ),
    (
        "double-chime-scheduled-by-gap-alone",
        ["src/speedDing.ts"],
        r"setTimeout\(\(\)\s*=>\s*\{\s*void\s+playOnce(Native|Web)\(\);?\s*\},\s*GAP_MS\)",
        "2026-09-10 (Jeff: 'the first speed ding tripled up'): the double chime's second ding was scheduled "
        "GAP_MS (190 ms) after the first one LOADED, into a 480 ms clip — the two overlapped into three audible "
        "beats. playOnceNative/playOnceWeb resolve when the clip has ENDED; the second ding is awaited after them.",
    ),
    (
        "estimator-fed-a-rate-sample",
        ["src/**/*.tsx", "src/**/*.ts"],
        r"posePredict\([^)]*getYawRateDps",
        "2026-09-10 (Jeff: 'the car was pointing left and right consistently the whole time … overshot "
        "the corners'): the estimator was handed ONE instantaneous rotationRate sample per render frame "
        "and integrated it as rate×dt. Mount vibration made those samples ±33°/s on a straight highway "
        "(sd 21°/s, real turn ~1°/s), so the heading random-walked between fixes and ran 31° off in the "
        "city corners. posePredict takes the sensor's CUMULATIVE yaw (getYawIntegralDeg — fused attitude) "
        "and differences it itself. Never feed it getYawRateDps().",
    ),
    (
        "watch-haptic-math-in-swift",
        ["targets/watch/**/*.swift", "targets/watch-widget/**/*.swift", "modules/hairpin-watch/ios/**/*.swift"],
        r"(distM|speedMs|WATCH_NOW_M|WATCH_PREPARE)[^\n]*(<=|>=|<|>)",
        "The wrist-tap decision lives ONLY in src/watchTaps.ts (node-gated). The watch plays what it is told. "
        "Note a local alias (`m >= 1000`) is not caught — reviewers read the wrist Swift for that.",
    ),
]

def blank_comments(text: str) -> str:
    """Replace the contents of // line comments and /* */ blocks with spaces, keeping every
    newline so line numbers survive. History is allowed to QUOTE a trap; code is not."""
    out = []; i = 0; n = len(text); in_str = None
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n: out.append(text[i + 1]); i += 2; continue
            if c == in_str: in_str = None
            i += 1; continue
        if c in ("'", '"', "`"):
            in_str = c; out.append(c); i += 1; continue
        if text.startswith("//", i):
            j = text.find("\n", i); j = n if j < 0 else j
            out.append(" " * (j - i)); i = j; continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2); j = n if j < 0 else j + 2
            out.append("".join("\n" if ch == "\n" else " " for ch in text[i:j])); i = j; continue
        out.append(c); i += 1
    return "".join(out)

def files_for(globs):
    seen = set()
    for g in globs:
        for f in ROOT.glob(g):
            if "node_modules" in f.parts or not f.is_file():
                continue
            seen.add(f)
    return sorted(seen)


def main():
    if "--list" in sys.argv:
        for rid, globs, _, why in RULES:
            print(f"{rid}\n  files: {', '.join(globs)}\n  why: {why}\n")
        return 0
    bad = 0
    for rid, globs, rx, why in RULES:
        pat = re.compile(rx)
        for f in files_for(globs):
            raw = f.read_text(encoding="utf-8", errors="replace")
            text = blank_comments(raw) if f.suffix in (".ts", ".tsx", ".js", ".swift") else raw
            for m in pat.finditer(text):
                line_start = text.rfind("\n", 0, m.start()) + 1
                line = raw[line_start:raw.find("\n", m.start())]
                if f.suffix == ".md" and line.lstrip().startswith(("-", ">", "#", "<!--")):
                    continue   # prose quoting the trap is allowed; only a fenced command counts
                ln = text.count("\n", 0, m.start()) + 1
                print(f"TRAP {rid}: {f.relative_to(ROOT)}:{ln}\n    {line.strip()[:140]}\n    why: {why}\n")
                bad += 1
    if bad:
        print(f"trap-check: {bad} hit(s) — do not publish.")
        return 1
    print(f"trap-check: {len(RULES)} rules, 0 hits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
