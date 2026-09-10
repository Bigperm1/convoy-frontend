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
            text = blank_comments(raw) if f.suffix in (".ts", ".tsx", ".js") else raw
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
