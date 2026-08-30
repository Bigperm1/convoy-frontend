#!/usr/bin/env python3
"""doc-check.py — catch the half of doc rot a machine can catch.

WHY (2026-08-30): building an Obsidian vault out of these docs surfaced that the two
files anyone reads FIRST were pointing at code that had moved. CLAUDE.md called
map.tsx "~3000 lines" when it was 5,946. CARPLAY.md rule 1 — the hook rule that cost
TWO crashes on 2026-07-24 — cited an early-return that had drifted ~1,200 lines onto
an unrelated comment. A stale pointer is worse than none: it sends the next reader to
unrelated code, they conclude the rule doesn't apply, and they add the hook anyway.

Nobody was neglecting the docs. Rot is created by CHANGES, not by time — deleting
src/powerMode.ts on 2026-08-29 orphaned a reference in WHY-IT-HEATS.md the same night.
So this is meant to run on the way past (see the OTA ritual), not as a scheduled chore
that gets skipped exactly when shipping is fastest.

⚠ WHAT THIS CANNOT DO. It checks that references POINT somewhere real. It cannot tell
you a doc is LYING — a paragraph that cites a live file and describes behaviour that
changed passes clean. That is the expensive kind: CLAUDE.md described routing as
"Google Routes API v2" for months after the 2026-06-14 move to Mapbox, and that stale
line was repeated back to Jeff as fact. Only reading catches that, and the moment to
read is when you touch the subsystem.

Usage:
    python3 scripts/doc-check.py            # all docs
    python3 scripts/doc-check.py --live     # only the docs CLAUDE.md treats as current
Exit 1 if anything in scope is broken, so it can gate a release.
"""
import glob
import os
import re
import sys

# CLAUDE.md marks these history-only: they are dated snapshots and their references are
# SUPPOSED to rot. Rewriting them would destroy their value as a record, so by default
# they are reported but never fail the run.
HISTORY_ONLY = {"HANDOFF.md", "HANDOFF-3D.md", "HANDOFF-48H-2026-08-16.md",
                "CARPLAY_MAC_HANDOFF.md"}

PATH_RE = re.compile(r'((?:src|app|tools|scripts|plugins|patches|modules)/'
                     r'[A-Za-z0-9_\-./()@]+\.[A-Za-z0-9]{1,4})')
CITE_RE = re.compile(r'\b([A-Za-z][A-Za-z0-9_]*\.tsx?):(\d{2,5})\b')
LINES_RE = re.compile(r'~([\d,]{3,7})\s*lines')


def line_count(p):
    try:
        with open(p, errors="ignore") as f:
            return sum(1 for _ in f)
    except OSError:
        return None


def resolve(basename):
    for pat in (f"src/**/{basename}", f"app/**/{basename}", f"modules/**/{basename}"):
        hits = glob.glob(pat, recursive=True)
        if hits:
            return hits[0]
    return None


def main():
    live_only = "--live" in sys.argv
    docs = sorted(d for d in glob.glob("*.md")
                  if not (live_only and d in HISTORY_ONLY))
    hard, soft = [], []

    for doc in docs:
        historical = doc in HISTORY_ONLY
        bucket = soft if historical else hard
        with open(doc, errors="ignore") as fh:
            for i, line in enumerate(fh, 1):
                # A doc must be able to NAME a deleted file in order to explain that it
                # was deleted — that is the most useful sentence in a changelog, and a
                # naive checker forbids exactly it. Opt out per line, and say why.
                # Found immediately: the fix for the powerMode.ts break mentioned
                # powerMode.ts, so the checker failed the sentence documenting the fix.
                if "doc-check:ignore" in line:
                    continue
                # 1. referenced repo paths must exist
                for m in PATH_RE.finditer(line):
                    p = m.group(1)
                    if not os.path.exists(p):
                        bucket.append((doc, i, f"dead path: {p}"))
                # 2. file:line citations must be inside the file
                for m in CITE_RE.finditer(line):
                    base, ln = m.group(1), int(m.group(2))
                    real = resolve(base)
                    if not real:
                        continue
                    n = line_count(real)
                    if n and ln > n:
                        bucket.append((doc, i, f"{base}:{ln} but file is {n} lines"))
                # 3. "~N lines" claims, 25% tolerance — these silently double
                for m in LINES_RE.finditer(line):
                    claimed = int(m.group(1).replace(",", ""))
                    ctx = PATH_RE.search(line) or CITE_RE.search(line)
                    if not ctx:
                        continue
                    target = ctx.group(1)
                    real = target if os.path.exists(target) else resolve(target)
                    n = line_count(real) if real else None
                    if n and abs(n - claimed) / max(n, 1) > 0.25:
                        bucket.append((doc, i, f"claims ~{claimed:,} lines, {target} is {n:,}"))

    def show(title, rows):
        print(f"\n{title}: {len(rows)}")
        for d, i, msg in rows:
            print(f"  {d}:{i}  {msg}")

    print(f"doc-check — {len(docs)} docs")
    if soft:
        show("STALE in history-only docs (expected, not failing)", soft)
    show("BROKEN in live docs", hard)

    if hard:
        print("\nLive docs are the ones every session reads first. Fix by citing CONTENT")
        print("(a grep for the comment text) rather than a line number — see CARPLAY.md rule 1.")
        return 1
    print("\nLive docs clean. ⚠ Structural only — a doc can still describe behaviour that changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
