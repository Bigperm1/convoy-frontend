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
        r"lineTrimOffset\s*:\s*\[?\s*(?:trim|cut|frac|ribbon|_frac)",
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
